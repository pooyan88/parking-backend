require('dotenv').config();
const { validateEnvironment } = require('./Utils/config');
const { port } = validateEnvironment();
const app = require('./app');
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
