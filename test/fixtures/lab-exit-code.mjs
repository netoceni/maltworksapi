process.stdout.write(JSON.stringify({ completed: true }) + '\n');
process.exitCode = Number(process.argv[2] ?? 0);
