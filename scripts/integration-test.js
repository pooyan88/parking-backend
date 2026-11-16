const { spawnSync } = require('node:child_process');
require('dotenv').config({ quiet: true });
if (!process.env.PARKING_TEST_DATABASE_URL) {
    console.error('Set PARKING_TEST_DATABASE_URL to a local maintenance database whose role can create disposable databases.');
    process.exitCode = 1;
} else {
    const result = spawnSync(process.execPath, ['--test', 'test/parkingOwnership.integration.test.js', 'test/rental.integration.test.js', 'test/appFixes.integration.test.js'], { stdio: 'inherit' });
    process.exitCode = result.status ?? 1;
}
