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

program.parseAsync().catch(error => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
