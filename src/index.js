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
const EXIT_CODES = { ECREDENTIALS: 3, ELOCKED: 3, ENOLIMIT: 4, EBOOKING_UNVERIFIED: 5 };

program.parseAsync().catch(error => {
  console.error(`Error: ${error.message}`);
  process.exitCode = EXIT_CODES[error?.code] || 1;
});
