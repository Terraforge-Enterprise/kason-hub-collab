process.stdout.write(JSON.stringify({ v: process.env.SDD_TEST_VAR ?? null, cwd: process.cwd() }));
