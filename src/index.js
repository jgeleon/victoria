#!/usr/bin/env node

import { program } from 'commander';
import { botCommand } from './commands/bot.js';

program
  .name('us-visa-bot')
  .description('Automated US visa appointment booking and rescheduling bot')
  .version('0.0.1');

program
  .command('bot')
  .description('Monitor and book/reschedule visa appointments')
  .option('-c, --current <date>', 'current booked date (optional if --max is provided)')
  .option('-x, --max <date>', 'maximum acceptable date (upper bound for date range)')
  .option('-t, --target <date>', 'alias for --max (deprecated)')
  .option('-m, --min <date>', 'minimum date acceptable')
  .option('--dry-run', 'only log what would be booked without actually booking')
  .option('--once', 'check availability once and exit')
  .action(botCommand);

// Default command for backward compatibility
program
  .option('-c, --current <date>', 'current booked date (optional if --max is provided)')
  .option('-x, --max <date>', 'maximum acceptable date (upper bound for date range)')
  .option('-t, --target <date>', 'alias for --max (deprecated)')
  .option('-m, --min <date>', 'minimum date acceptable')
  .option('--dry-run', 'only log what would be booked without actually booking')
  .option('--once', 'check availability once and exit')
  .action(botCommand);

// Códigos que el supervisor no debe revivir:
// 3 = credenciales/cuenta bloqueada, 4 = sin reprogramaciones
// 5 = reserva sin verificar: hay que revisar el portal a mano antes de seguir
// 6 = la cita ya está en el límite mínimo: no hay nada que mejorar
const EXIT_CODES = { ECREDENTIALS: 3, ELOCKED: 3, ENOLIMIT: 4, EBOOKING_UNVERIFIED: 5, EAT_LIMIT: 6 };

program.parseAsync().catch(error => {
  console.error(`Error: ${error.message}`);
  process.exitCode = EXIT_CODES[error?.code] || 1;
}).finally(() => {
  // El canal IPC con el servidor mantiene vivo el proceso: cerrarlo para que el bot termine con
  // su código y el servidor marque el estado correcto. Red de seguridad por si queda algo abierto.
  if (process.connected) {
    process.removeAllListeners('disconnect'); // este cierre es nuestro, no una caída del servidor
    process.disconnect();
  }
  setTimeout(() => process.exit(process.exitCode ?? 0), 1500).unref();
});
