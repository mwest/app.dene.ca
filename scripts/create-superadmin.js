// Create (or promote) the superadmin account.
// Usage: npm run create-superadmin -- <email> <name> <password>
import db from '../src/db.js';
import { hashPassword } from '../src/auth.js';

const [email, name, password] = process.argv.slice(2);

if (!email || !name || !password) {
  console.error('Usage: npm run create-superadmin -- <email> <name> <password>');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
if (existing) {
  db.prepare('UPDATE users SET name = ?, password_hash = ?, is_superadmin = 1 WHERE id = ?').run(
    name, hashPassword(password), existing.id
  );
  console.log(`Updated ${email} and promoted to superadmin.`);
} else {
  db.prepare('INSERT INTO users (email, name, password_hash, is_superadmin) VALUES (?, ?, ?, 1)').run(
    email, name, hashPassword(password)
  );
  console.log(`Superadmin account created for ${email}.`);
}
