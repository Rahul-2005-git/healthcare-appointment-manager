import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Navbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const home = user?.role === 'admin' ? '/admin' : user?.role === 'doctor' ? '/doctor' : '/patient';

  return (
    <div className="navbar">
      <Link to={user ? home : '/login'} className="brand">
        <span className="dot" />
        Clinic Care
      </Link>
      {user && (
        <nav>
          <span className="role-badge">{user.role}</span>
          <span>{user.name}</span>
          <button className="linklike" onClick={() => { logout(); navigate('/login'); }}>
            Log out
          </button>
        </nav>
      )}
    </div>
  );
}
