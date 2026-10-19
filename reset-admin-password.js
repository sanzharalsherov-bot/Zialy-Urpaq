
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const dotenv = require('dotenv');
const path = require('node:path');

dotenv.config({ path: path.join(__dirname, '.env') });

const prisma = new PrismaClient();

function askPassword(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
      reject(new Error('Запустите скрипт в интерактивном терминале'));
      return;
    }

    let password = '';
    process.stdout.write(prompt);
    process.stdin.setEncoding('utf8');
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const finish = (error) => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(password);
    };

    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\u0003') {
          finish(new Error('Сброс отменён'));
          return;
        }
        if (char === '\r' || char === '\n') {
          finish();
          return;
        }
        if (char === '\u0008' || char === '\u007f') {
          if (password.length) {
            password = password.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        password += char;
        process.stdout.write('*');
      }
    };

    process.stdin.on('data', onData);
  });
}

async function main() {
  const password = await askPassword('Введите новый пароль: ');

  if (password.length < 12) {
    throw new Error('Пароль должен содержать минимум 12 символов');
  }

  const existingUser = await prisma.user.findUnique({
    where: { email: 'admin@school.local' },
    select: { id: true, role: true },
  });

  if (existingUser && existingUser.role !== 'ADMIN') {
    throw new Error('Этот email уже принадлежит пользователю без роли администратора');
  }

  const passwordHash = await bcrypt.hash(password, 12);

  if (existingUser) {
    await prisma.user.update({ where: { id: existingUser.id }, data: { passwordHash } });
    console.log('Пароль администратора admin@school.local успешно изменён.');
  } else {
    await prisma.user.create({
      data: {
        email: 'admin@school.local',
        passwordHash,
        firstName: 'Администратор',
        lastName: 'Школы',
        role: 'ADMIN',
      },
    });
    console.log('Создан аккаунт администратора admin@school.local.');
  }

}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
