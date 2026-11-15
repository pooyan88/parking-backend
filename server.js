const express = require('express');
require('dotenv').config();
const router = require('./Router/parkingRouter');
const authRouter = require('./Router/authRouter');
const parkingFloorRouter = require('./Router/parkingFloorRouter');
const app = express();
const port = 3002;

app.use(express.json());
app.use(router);
app.use(authRouter);
app.use(parkingFloorRouter);

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
