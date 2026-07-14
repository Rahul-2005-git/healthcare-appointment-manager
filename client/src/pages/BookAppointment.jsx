import { useState } from 'react';
import { api } from '../api/client';

const URGENCY_CLASS = {
  Low: 'urgency-low', Medium: 'urgency-medium', High: 'urgency-high', Unknown: 'urgency-unknown',
};

function formatSlot(iso) {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default function BookAppointment({ onBooked }) {
  const [specialisation, setSpecialisation] = useState('');
  const [doctors, setDoctors] = useState([]);
  const [selectedDoctor, setSelectedDoctor] = useState(null);
  const [date, setDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  });
  const [slots, setSlots] = useState([]);
  const [slotsReason, setSlotsReason] = useState(null);
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [hold, setHold] = useState(null);
  const [symptomText, setSymptomText] = useState('');
  const [step, setStep] = useState('search'); // search -> slots -> symptoms -> done
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [bookedAppointment, setBookedAppointment] = useState(null);

  async function handleSearch(e) {
    e?.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { doctors } = await api.searchDoctors(specialisation);
      setDoctors(doctors);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadSlots(doctor, forDate) {
    setError('');
    setSelectedDoctor(doctor);
    setSelectedSlot(null);
    setLoading(true);
    try {
      const res = await api.getSlots(doctor.id, forDate);
      setSlots(res.slots);
      setSlotsReason(res.reason || null);
      setStep('slots');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleHold(slot) {
    setError('');
    setSelectedSlot(slot);
    setLoading(true);
    try {
      const res = await api.holdSlot({ doctorId: selectedDoctor.id, slotStart: slot.start, slotEnd: slot.end });
      setHold(res);
      setStep('symptoms');
    } catch (err) {
      setError(err.message);
      // Slot likely taken — refresh availability.
      loadSlots(selectedDoctor, date);
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirm(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { appointment } = await api.confirmBooking({ holdId: hold.holdId, symptomText });
      setBookedAppointment(appointment);
      setStep('done');
      onBooked?.();
    } catch (err) {
      setError(err.message);
      setStep('search');
      setHold(null);
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setStep('search'); setSelectedDoctor(null); setSlots([]); setSelectedSlot(null);
    setHold(null); setSymptomText(''); setBookedAppointment(null); setError('');
  }

  return (
    <div className="card">
      <h2>Book an appointment</h2>

      {error && <div className="error-banner">{error}</div>}

      {step === 'search' && (
        <>
          <form onSubmit={handleSearch} className="grid-2" style={{ alignItems: 'end' }}>
            <div>
              <label>Search by specialisation</label>
              <input
                placeholder="e.g. Cardiology, General Physician"
                value={specialisation}
                onChange={(e) => setSpecialisation(e.target.value)}
              />
            </div>
            <div>
              <button className="btn" type="submit" disabled={loading}>{loading ? 'Searching…' : 'Search doctors'}</button>
            </div>
          </form>

          {doctors.length > 0 && (
            <table className="data-table">
              <thead>
                <tr><th>Doctor</th><th>Specialisation</th><th>Hours</th><th></th></tr>
              </thead>
              <tbody>
                {doctors.map((d) => (
                  <tr key={d.id}>
                    <td>{d.name}</td>
                    <td>{d.specialisation}</td>
                    <td>{d.working_hours_start}–{d.working_hours_end}</td>
                    <td>
                      <button className="btn secondary" onClick={() => loadSlots(d, date)}>View slots</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {step === 'slots' && selectedDoctor && (
        <>
          <p className="muted">Dr. {selectedDoctor.name} — {selectedDoctor.specialisation}</p>
          <label>Date</label>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 6 }}>
            <input type="date" value={date} onChange={(e) => { setDate(e.target.value); loadSlots(selectedDoctor, e.target.value); }} style={{ maxWidth: 200 }} />
            <button className="btn secondary" onClick={() => setStep('search')}>Back to search</button>
          </div>

          {slotsReason === 'doctor_on_leave' && <div className="error-banner">The doctor is on leave this date. Please choose another date.</div>}
          {slotsReason === 'not_a_working_day' && <div className="error-banner">The doctor doesn't work on this day. Please choose another date.</div>}

          {slots.length === 0 && !slotsReason && <p className="muted">No available slots on this date.</p>}

          <div className="slot-grid">
            {slots.map((s) => (
              <button
                key={s.start}
                className={`slot-btn${selectedSlot?.start === s.start ? ' selected' : ''}`}
                onClick={() => handleHold(s)}
                disabled={loading}
              >
                {formatSlot(s.start).split(', ').slice(-1)}
              </button>
            ))}
          </div>
        </>
      )}

      {step === 'symptoms' && selectedSlot && (
        <form onSubmit={handleConfirm}>
          <p className="muted">
            Booking Dr. {selectedDoctor.name} on <strong>{formatSlot(selectedSlot.start)}</strong>. This slot is held for {hold?.expiresInMinutes} minutes.
          </p>
          <label>Describe your symptoms</label>
          <textarea
            value={symptomText}
            onChange={(e) => setSymptomText(e.target.value)}
            placeholder="e.g. Fever and sore throat for 2 days, mild headache, no cough"
            required
          />
          <p className="muted" style={{ marginTop: -8 }}>
            An AI-generated summary and urgency level will be shared with your doctor ahead of the visit.
          </p>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn" type="submit" disabled={loading}>{loading ? 'Confirming…' : 'Confirm booking'}</button>
            <button className="btn secondary" type="button" onClick={reset}>Cancel</button>
          </div>
        </form>
      )}

      {step === 'done' && bookedAppointment && (
        <div>
          <div className="success-banner">Appointment confirmed for {formatSlot(bookedAppointment.slot_start)}.</div>
          {bookedAppointment.pre_visit_summary_json && (() => {
            const summary = JSON.parse(bookedAppointment.pre_visit_summary_json);
            return (
              <div className="card" style={{ background: 'var(--surface-sunken)', boxShadow: 'none' }}>
                <div className="eyebrow">Pre-visit summary shared with your doctor</div>
                <span className={`badge urgency-${(summary.urgencyLevel || 'unknown').toLowerCase()}`}>
                  {summary.urgencyLevel} urgency
                </span>
                <p style={{ marginTop: 10 }}>{summary.chiefComplaint}</p>
              </div>
            );
          })()}
          <button className="btn secondary" onClick={reset} style={{ marginTop: 10 }}>Book another appointment</button>
        </div>
      )}
    </div>
  );
}
