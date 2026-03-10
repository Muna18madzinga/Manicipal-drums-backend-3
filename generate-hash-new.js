const bcrypt = require('bcryptjs');

const password = 'admin123';

bcrypt.hash(password, 12, (err, hash) => {
  if (err) {
    console.error('Error:', err);
  } else {
    console.log('New hash:', hash);
  }
});
