import app from './app.js';
import { startCalendarScheduler } from './lib/calendarScheduler.js';

const PORT = process.env.API_PORT || 8001;
app.listen(PORT, () => {
    console.log(`Alba Content Hub API listening on http://localhost:${PORT}`);
    startCalendarScheduler();
});
