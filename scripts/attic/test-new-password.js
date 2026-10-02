const bcrypt = require('bcryptjs');

const password = 'admin123';
const hash = '$2a$12$5AAb7OZknDUSF/aRQROsfuLRpnlGNU/.Eh4d/LhOnE2PQiz0XwZSW';

bcrypt.compare(password, hash, (err, result) => {
  if (err) {
    console.error('Error:', err);
  } else {
    console.log('Password match:', result);
  }
});
