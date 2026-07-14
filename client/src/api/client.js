const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:4000/api';

function getToken() {
  return localStorage.getItem('token');
}

async function request(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = {};
  try {
    data = await res.json();
  } catch {
    // no body
  }

  if (!res.ok) {
    const message = data?.error || `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  register: (payload) => request('/auth/register', { method: 'POST', body: payload, auth: false }),
  login: (payload) => request('/auth/login', { method: 'POST', body: payload, auth: false }),
  me: () => request('/auth/me'),

  searchDoctors: (specialisation) =>
    request(`/doctors${specialisation ? `?specialisation=${encodeURIComponent(specialisation)}` : ''}`),
  getSlots: (doctorId, date) => request(`/doctors/${doctorId}/slots?date=${date}`),

  holdSlot: (payload) => request('/appointments/hold', { method: 'POST', body: payload }),
  confirmBooking: (payload) => request('/appointments/confirm', { method: 'POST', body: payload }),
  cancelAppointment: (id, reason) => request(`/appointments/${id}/cancel`, { method: 'POST', body: { reason } }),
  myAppointments: () => request('/appointments/mine'),
  doctorAppointments: () => request('/appointments/doctor'),
  submitPostVisit: (id, payload) => request(`/appointments/${id}/post-visit`, { method: 'POST', body: payload }),

  adminListDoctors: () => request('/admin/doctors'),
  adminCreateDoctor: (payload) => request('/admin/doctors', { method: 'POST', body: payload }),
  adminUpdateDoctor: (id, payload) => request(`/admin/doctors/${id}`, { method: 'PATCH', body: payload }),
  adminAddLeave: (id, payload) => request(`/admin/doctors/${id}/leaves`, { method: 'POST', body: payload }),

  calendarConnect: () => request('/calendar/google/connect'),
  calendarStatus: () => request('/calendar/google/status'),
};
