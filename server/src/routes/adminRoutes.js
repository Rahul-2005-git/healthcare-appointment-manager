const router = require('express').Router();
const { authenticate, authorize } = require('../middleware/auth');
const { createDoctor, listDoctors, updateDoctor, addLeave } = require('../controllers/adminController');

router.use(authenticate, authorize('admin'));

router.post('/doctors', createDoctor);
router.get('/doctors', listDoctors);
router.patch('/doctors/:id', updateDoctor);
router.post('/doctors/:id/leaves', addLeave);

module.exports = router;
