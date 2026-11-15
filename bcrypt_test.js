const bcrypt = require('bcrypt');

async function testBcrypt() {
    const password = 'MyPassword123';

    // Convert password into a secure hash
    const passwordHash = await bcrypt.hash(password, 12);

    console.log('Original password:', password);
    console.log('Password hash:', passwordHash);

    // Check if the password matches the hash
    const isValid = await bcrypt.compare("wrong Password", passwordHash);

    console.log('Password is valid:', isValid);
}

testBcrypt();