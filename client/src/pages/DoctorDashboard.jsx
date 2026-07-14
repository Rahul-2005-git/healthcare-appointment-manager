import { useEffect, useState } from 'react';
import { api } from '../api/client';
import PulseDivider from '../components/PulseDivider';

function formatSlot(iso) {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function emptyMed() {
  return { medication: '', dosage: '', frequencyPerDay: 2, durationDays: 5 };
}

function PostVisitForm({ appt, onDone }) {
  const [notes, setNotes] = useState('');
  const [meds, setMeds] = useState([emptyMed()]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  function updateMed(i, field, value) {
    setMeds((m) => m.map((row, idx) => (idx === i ? { ...row, [field]: value } : row)));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const prescription = meds.filter((m) => m.medication.trim()).map((m) => ({
        medication: m.medication, dosage: m.dosage,
        frequencyPerDay: Number(m.frequencyPerDay), durationDays: Number(m.durationDays),
      }));
      await api.submitPostVisit(appt.id, { notes, prescription });
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="card" style={{ background: 'var(--surface-sunken)', boxShadow: 'none' }}>
      {error && <div className="error-banner">{error}</div>}
      <label>Clinical notes</label>
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} required placeholder="Diagnosis, observations, advice given…" />

      <div className="eyebrow">Prescription</div>
      {meds.map((m, i) => (
        <div key={i} className="grid-2" style={{ marginBottom: 4 }}>
          <div>
            <label>Medication</label>
            <input value={m.medication} onChange={(e) => updateMed(i, 'medication', e.target.value)} placeholder="e.g. Amoxicillin 500mg" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
            <div>
              <label>Dosage</label>
              <input value={m.dosage} onChange={(e) => updateMed(i, 'dosage', e.target.value)} placeholder="500mg" />
            </div>
            <div>
              <label>Times/day</label>
              <input type="number" min="1" value={m.frequencyPerDay} onChange={(e) => updateMed(i, 'frequencyPerDay', e.target.value)} />
            </div>
            <div>
              <label>Days</label>
              <input type="number" min="1" value={m.durationDays} onChange={(e) => updateMed(i, 'durationDays', e.target.value)} />
            </div>
          </div>
        </div>
      ))}
      <button type="button" className="btn secondary" onClick={() => setMeds((m) => [...m, emptyMed()])} style={{ marginBottom: 14 }}>
        + Add medication
      </button>
      <div>
        <button className="btn" type="submit" disabled={loading}>{loading ? 'Saving…' : 'Save & generate patient summary'}</button>
      </div>
    </form>
  );
}

function AppointmentRow({ appt, onUpdated }) {
  const [expanded, setExpanded] = useState(false);
  const preVisit = appt.pre_visit_summary_json ? JSON.parse(appt.pre_visit_summary_json) : null;

  return (
    <div className="appt-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <div>
          <strong>{appt.patient_name}</strong>
          <div className="muted">{formatSlot(appt.slot_start)}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <span className={`badge ${appt.status}`}>{appt.status}</span>
          {preVisit && (
            <span className={`badge urgency-${(preVisit.urgencyLevel || 'unknown').toLowerCase()}`} style={{ marginLeft: 6 }}>
              {preVisit.urgencyLevel}
            </span>
          )}
          <div style={{ marginTop: 8 }}>
            <button className="btn secondary" onClick={() => setExpanded((v) => !v)}>{expanded ? 'Hide' : 'View'}</button>
          </div>
        </div>
      </div>

      {expanded && (
        <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
          {appt.symptom_text && (
            <div><div className="eyebrow">Patient-reported symptoms</div><p style={{ margin: 0 }}>{appt.symptom_text}</p></div>
          )}
          {preVisit && (
            <div className="card" style={{ boxShadow: 'none', background: '#fff', margin: 0 }}>
              <div className="eyebrow">AI pre-visit summary</div>
              <p><strong>Chief complaint:</strong> {preVisit.chiefComplaint}</p>
              {preVisit.suggestedQuestions?.length > 0 && (
                <>
                  <p style={{ marginBottom: 4 }}><strong>Suggested questions:</strong></p>
                  <ul className="plain">
                    {preVisit.suggestedQuestions.map((q, i) => <li key={i}>• {q}</li>)}
                  </ul>
                </>
              )}
              {preVisit.note && <p className="muted">{preVisit.note}</p>}
            </div>
          )}

          {appt.status === 'confirmed' && <PostVisitForm appt={appt} onDone={onUpdated} />}

          {appt.status === 'completed' && appt.post_visit_notes && (
            <div><div className="eyebrow">Your notes</div><p style={{ margin: 0 }}>{appt.post_visit_notes}</p></div>
          )}
        </div>
      )}
    </div>
  );
}

export default function DoctorDashboard() {
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('confirmed');

  async function load() {
    setLoading(true);
    try {
      const { appointments } = await api.doctorAppointments();
      setAppointments(appointments);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const filtered = appointments.filter((a) => (filter === 'all' ? true : a.status === filter));

  return (
    <div className="container">
      <h1>Doctor Portal</h1>
      <PulseDivider />

      <div className="tabs">
        <button className={filter === 'confirmed' ? 'active' : ''} onClick={() => setFilter('confirmed')}>Upcoming</button>
        <button className={filter === 'completed' ? 'active' : ''} onClick={() => setFilter('completed')}>Completed</button>
        <button className={filter === 'cancelled' ? 'active' : ''} onClick={() => setFilter('cancelled')}>Cancelled</button>
        <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All</button>
      </div>

      <div className="card">
        {loading && <p className="muted">Loading…</p>}
        {!loading && filtered.length === 0 && <p className="muted">No appointments in this view.</p>}
        {filtered.map((a) => <AppointmentRow key={a.id} appt={a} onUpdated={load} />)}
      </div>
    </div>
  );
}
