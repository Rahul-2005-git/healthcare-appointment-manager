// LLM integration for pre-visit and post-visit summaries.
//
// Design goal: an LLM outage or malformed response must NEVER block booking,
// confirmation, or completion of a visit. Every function here catches its own
// errors and returns a structured { ok, data, error } result instead of throwing,
// so callers can persist whatever comes back (including a graceful fallback)
// and keep going.

const TIMEOUT_MS = 15000;

async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.startsWith('your-')) {
    throw new Error('GEMINI_API_KEY is not configured');
  }
  const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: prompt }]
        }],
        generationConfig: {
          responseMimeType: 'application/json'
        }
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Gemini API error ${response.status}: ${text.slice(0, 300)}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini response contained no text block');
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function callOpenAI(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey.startsWith('your-')) {
    throw new Error('OPENAI_API_KEY is not configured');
  }
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const url = 'https://api.openai.com/v1/chat/completions';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`OpenAI API error ${response.status}: ${text.slice(0, 300)}`);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('OpenAI response contained no content');
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function callLLM(prompt) {
  let provider = process.env.LLM_PROVIDER;

  if (!provider) {
    const geminiKey = process.env.GEMINI_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    const hasGemini = geminiKey && !geminiKey.startsWith('your-');
    const hasOpenAI = openaiKey && !openaiKey.startsWith('your-');

    if (hasGemini) {
      provider = 'gemini';
    } else if (hasOpenAI) {
      provider = 'openai';
    } else {
      throw new Error('Neither GEMINI_API_KEY nor OPENAI_API_KEY is configured');
    }
  }

  provider = provider.toLowerCase();

  if (provider === 'gemini') {
    return await callGemini(prompt);
  } else if (provider === 'openai') {
    return await callOpenAI(prompt);
  } else {
    throw new Error(`Unsupported LLM provider: ${provider}`);
  }
}

// Extracts the first {...} or [...] JSON value from a string, tolerating
// markdown code fences or stray prose the model might add despite instructions.
function extractJson(raw) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.search(/[{[]/);
  if (start === -1) throw new Error('No JSON found in LLM output');
  const jsonStr = candidate.slice(start);
  return JSON.parse(jsonStr);
}

async function generatePreVisitSummary(symptomText) {
  const prompt = `Analyse these symptoms and return ONLY a JSON object (no prose, no markdown fences) with exactly these keys:
{
  "urgencyLevel": "Low" | "Medium" | "High",
  "chiefComplaint": string,
  "suggestedQuestions": [string, string, string]
}
Symptoms: ${symptomText}`;

  try {
    const raw = await callLLM(prompt);
    const parsed = extractJson(raw);

    if (!parsed.urgencyLevel || !parsed.chiefComplaint || !Array.isArray(parsed.suggestedQuestions)) {
      throw new Error('LLM JSON missing required fields');
    }

    return { ok: true, status: 'ok', data: parsed, error: null };
  } catch (err) {
    // Fallback: doctor still gets something usable, flagged as LLM-unavailable.
    return {
      ok: false,
      status: 'failed',
      data: {
        urgencyLevel: 'Unknown',
        chiefComplaint: symptomText ? symptomText.slice(0, 200) : 'Not provided',
        suggestedQuestions: [
          'Could you describe your main symptom in more detail?',
          'When did the symptoms start?',
          'Have you taken any medication for this already?',
        ],
        note: 'Automatic summary unavailable — showing raw patient input. Please review manually.',
      },
      error: err.message,
    };
  }
}

async function generatePostVisitSummary(clinicalNotes, prescription) {
  const prescriptionText = Array.isArray(prescription) && prescription.length
    ? prescription.map((p) => `${p.medication} ${p.dosage || ''} — ${p.frequencyPerDay || '?'}x/day for ${p.durationDays || '?'} days`).join('; ')
    : 'None prescribed';

  const prompt = `Convert these clinical notes into a patient-friendly summary. Return ONLY a JSON object (no prose, no markdown fences) with exactly these keys:
{
  "summary": string,           // 2-4 plain-language sentences explaining the visit and diagnosis
  "medicationSchedule": [string], // one line per medication, plain language (e.g. "Take Amoxicillin 500mg twice a day for 7 days, after meals")
  "followUp": string           // what the patient should do next / when to return
}
Clinical notes: ${clinicalNotes}
Prescription: ${prescriptionText}`;

  try {
    const raw = await callLLM(prompt);
    const parsed = extractJson(raw);

    if (!parsed.summary || !Array.isArray(parsed.medicationSchedule) || !parsed.followUp) {
      throw new Error('LLM JSON missing required fields');
    }

    return { ok: true, status: 'ok', data: parsed, error: null };
  } catch (err) {
    return {
      ok: false,
      status: 'failed',
      data: {
        summary: 'Your doctor has recorded notes from your visit. An automatic summary could not be generated this time — please refer to the notes below or contact the clinic with questions.',
        medicationSchedule: Array.isArray(prescription)
          ? prescription.map((p) => `${p.medication}${p.dosage ? ' ' + p.dosage : ''} — ${p.frequencyPerDay || '?'} time(s)/day for ${p.durationDays || '?'} day(s)`)
          : [],
        followUp: 'Please contact the clinic if you have questions about your treatment.',
        note: 'Automatic summary unavailable.',
      },
      error: err.message,
    };
  }
}

module.exports = { generatePreVisitSummary, generatePostVisitSummary };
