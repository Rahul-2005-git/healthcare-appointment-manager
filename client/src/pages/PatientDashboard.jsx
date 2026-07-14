import { useEffect, useState } from 'react';
import { api } from '../api/client';
import PulseDivider from '../components/PulseDivider';
import BookAppointment from './BookAppointment';

function formatSlot(iso) {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function AppointmentCard({ appt, onCancelled }) {
  const [expanded, setExpanded] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const preVisit = appt.pre_visit_summary_json ? JSON.parse(appt.pre_visit_summary_json) : null;
  const postVisit = appt.post_visit_summary_json ? JSON.parse(appt.post_visit_summary_json) : null;

  async function handleCancel() {
    if (!confirm('Cancel this appointment?')) return;
    setCancelling(true);
    try {
      await api.cancelAppointment(appt.id, 'Cancelled by patient');
      onCancelled();
    } catch (err) {
      alert(err.message);
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="appt-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <div>
          <strong>Dr. {appt.doctor_name}</strong> — {appt.specialisation}
          <div className="muted">{formatSlot(appt.slot_start)}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <span className={`badge ${appt.status}`}>{appt.status}</span>
          <div style={{ marginTop: 8 }}>
            <button className="btn secondary" onClick={() => setExpanded((v) => !v)} style={{ marginRight: 6 }}>
              {expanded ? 'Hide details' : 'Details'}
            </button>
            {appt.status === 'confirmed' && (
              <button className="btn danger" onClick={handleCancel} disabled={cancelling}>
                {cancelling ? 'Cancelling…' : 'Cancel'}
              </button>
            )}
          </div>
        </div>
      </div>

      {expanded && (
        <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
          {appt.symptom_text && (
            <div>
              <div className="eyebrow">Symptoms you reported</div>
              <p style={{ margin: 0 }}>{appt.symptom_text}</p>
            </div>
          )}
          {preVisit && (
            <div>
              <div className="eyebrow">Pre-visit summary</div>
              <span className={`badge urgency-${(preVisit.urgencyLevel || 'unknown').toLowerCase()}`}>{preVisit.urgencyLevel} urgency</span>
            </div>
          )}
          {appt.cancel_reason && (
            <div><div className="eyebrow">Cancellation reason</div><p style={{ margin: 0 }}>{appt.cancel_reason}</p></div>
          )}
          {appt.post_visit_notes && (
            <div><div className="eyebrow">Doctor's notes</div><p style={{ margin: 0 }}>{appt.post_visit_notes}</p></div>
          )}
          {postVisit && (
            <div>
              <div className="eyebrow">Your visit summary</div>
              <p style={{ margin: '0 0 8px' }}>{postVisit.summary}</p>
              {postVisit.medicationSchedule?.length > 0 && (
                <>
                  <div className="eyebrow">Medication schedule</div>
                  <ul className="plain">
                    {postVisit.medicationSchedule.map((m, i) => <li key={i}>💊 {m}</li>)}
                  </ul>
                </>
              )}
              <div className="eyebrow" style={{ marginTop: 8 }}>Follow-up</div>
              <p style={{ margin: 0 }}>{postVisit.followUp}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function PatientDashboard() {
  const [tab, setTab] = useState('book');
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(true);

  async function loadAppointments() {
    setLoading(true);
    try {
      const { appointments } = await api.myAppointments();
      setAppointments(appointments);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadAppointments(); }, []);

  return (
    <div className="container">
      <h1>Patient Portal</h1>
      <PulseDivider />

      <div className="tabs">
        <button className={tab === 'book' ? 'active' : ''} onClick={() => setTab('book')}>Book appointment</button>
        <button className={tab === 'appointments' ? 'active' : ''} onClick={() => { setTab('appointments'); loadAppointments(); }}>
          My appointments {appointments.length ? `(${appointments.length})` : ''}
        </button>
      </div>

      {tab === 'book' && <BookAppointment onBooked={loadAppointments} />}

      {tab === 'appointments' && (
        <div className="card">
          {loading && <p className="muted">Loading…</p>}
          {!loading && appointments.length === 0 && <p className="muted">No appointments yet — book one from the "Book appointment" tab.</p>}
          {appointments.map((a) => (
            <AppointmentCard key={a.id} appt={a} onCancelled={loadAppointments} />
          ))}
        </div>
      )}
    </div>
  );
}
