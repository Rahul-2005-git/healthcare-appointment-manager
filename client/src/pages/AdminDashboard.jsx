import { useEffect, useState } from 'react';
import { api } from '../api/client';
import PulseDivider from '../components/PulseDivider';

function CreateDoctorForm({ onCreated }) {
  const [form, setForm] = useState({
    name: '', email: '', password: '', phone: '', specialisation: '',
    workingHoursStart: '09:00', workingHoursEnd: '17:00', slotDurationMins: 30, workingDays: '1,2,3,4,5',
  });
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  function update(field) { return (e) => setForm((f) => ({ ...f, [field]: e.target.value })); }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(''); setSuccess(''); setLoading(true);
    try {
      await api.adminCreateDoctor(form);
      setSuccess(`Doctor profile created for ${form.name}.`);
      setForm((f) => ({ ...f, name: '', email: '', password: '', phone: '', specialisation: '' }));
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="card">
      <h2>Add a doctor</h2>
      {error && <div className="error-banner">{error}</div>}
      {success && <div className="success-banner">{success}</div>}
      <div className="grid-2">
        <div>
          <label>Full name</label>
          <input value={form.name} onChange={update('name')} required />
        </div>
        <div>
          <label>Specialisation</label>
          <input value={form.specialisation} onChange={update('specialisation')} required placeholder="e.g. Dermatology" />
        </div>
        <div>
          <label>Email</label>
          <input type="email" value={form.email} onChange={update('email')} required />
        </div>
        <div>
          <label>Phone (optional)</label>
          <input value={form.phone} onChange={update('phone')} />
        </div>
        <div>
          <label>Initial password</label>
          <input type="password" value={form.password} onChange={update('password')} required minLength={6} />
        </div>
        <div>
          <label>Slot duration (minutes)</label>
          <input type="number" min="5" value={form.slotDurationMins} onChange={update('slotDurationMins')} />
        </div>
        <div>
          <label>Working hours start</label>
          <input type="time" value={form.workingHoursStart} onChange={update('workingHoursStart')} />
        </div>
        <div>
          <label>Working hours end</label>
          <input type="time" value={form.workingHoursEnd} onChange={update('workingHoursEnd')} />
        </div>
      </div>
      <button className="btn" type="submit" disabled={loading}>{loading ? 'Creating…' : 'Create doctor profile'}</button>
    </form>
  );
}

function LeaveForm({ doctor, onAdded }) {
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setError(''); setResult(null); setLoading(true);
    try {
      const res = await api.adminAddLeave(doctor.id, { date, reason });
      setResult(res);
      onAdded();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
      <div style={{ flex: '0 0 160px' }}>
        <label>Leave date</label>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
      </div>
      <div style={{ flex: 1, minWidth: 160 }}>
        <label>Reason (optional)</label>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Conference, illness…" />
      </div>
      <button className="btn secondary" type="submit" disabled={loading} style={{ marginBottom: 14 }}>
        {loading ? 'Saving…' : 'Mark on leave'}
      </button>
      {error && <div className="error-banner" style={{ width: '100%' }}>{error}</div>}
      {result && (
        <div className="success-banner" style={{ width: '100%' }}>
          Leave recorded.{result.cancelledAppointments.length > 0
            ? ` ${result.cancelledAppointments.length} existing appointment(s) were cancelled and both parties notified by email.`
            : ' No existing appointments were affected.'}
        </div>
      )}
    </form>
  );
}

export default function AdminDashboard() {
  const [doctors, setDoctors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState(null);

  async function load() {
    setLoading(true);
    try {
      const { doctors } = await api.adminListDoctors();
      setDoctors(doctors);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  return (
    <div className="container">
      <h1>Admin Portal</h1>
      <PulseDivider />

      <CreateDoctorForm onCreated={load} />

      <div className="card">
        <h2>Doctors</h2>
        {loading && <p className="muted">Loading…</p>}
        {!loading && doctors.length === 0 && <p className="muted">No doctors yet.</p>}
        {doctors.map((d) => (
          <div key={d.id} style={{ borderBottom: '1px solid var(--line)', padding: '14px 0' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <div>
                <strong>{d.name}</strong> — {d.specialisation}
                <div className="muted">{d.email} · {d.working_hours_start}–{d.working_hours_end} · {d.slot_duration_mins}min slots</div>
              </div>
              <button className="btn secondary" onClick={() => setExpandedId(expandedId === d.id ? null : d.id)}>
                {expandedId === d.id ? 'Hide' : 'Manage leave'}
              </button>
            </div>
            {expandedId === d.id && (
              <div style={{ marginTop: 12 }}>
                <LeaveForm doctor={d} onAdded={load} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
