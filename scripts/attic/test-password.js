const bcrypt = require('bcryptjs');

const password = 'admin123';
const hash = '$2b$12$ixETFSa0aYJlchCz83ON.eKvSo72QPBfcpuD0VC/GjVdKEPXiz/qi';

bcrypt.compare(password, hash, (err, result) => {
  if (err) {
    console.error('Error:', err);
  } else {
    console.log('Password match:', result);
  }
});
