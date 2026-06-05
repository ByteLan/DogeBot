import { addUser } from '../src/auth.js';

const [, , username, password] = process.argv;
if (!username || !password) {
  console.error('Usage: pnpm add-user <username> <password>');
  process.exit(1);
}

try {
  addUser(username, password);
  console.log(`Created user: ${username}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
