const express = require('express');
const router = require('./Router/parkingRouter');
const app = express();
const port = 3002;

app.use(express.json());
app.use(router);

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
