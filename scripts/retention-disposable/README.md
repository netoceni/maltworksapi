# Maltworks v5.19 — disposable D1 retention drill

**Scope:** only a fresh database named `maltworks-retention-disposable-20261030`.
Do **not** run the fixture files using `wrangler.lab-staging.jsonc`, production,
or any existing DB. No Worker is deployed and no routes or Cron are created.

This SQL drill validates **remote D1 SQL behavior**, not the TypeScript scheduler
or its bounded 12-hour catch-up loops. Those are tested separately with the
existing Vitest real-SQL integration tests. The fixture uses a fixed reference
timestamp so its seven-day boundary does not drift between steps.

## 1. Create fresh DB, separate Wrangler config and apply migrations

In PowerShell in `$HOME\maltworksapi-staging`:

```powershell
Set-Location "$HOME\maltworksapi-staging"
git pull --ff-only origin test/staging-history-lab-free10-20261028
if ($LASTEXITCODE -ne 0) { throw "Git failed" }

$name = "maltworks-retention-disposable-20261030"

# Must be a brand-new database. Do not substitute staging/production names.
npx.cmd wrangler d1 create $name --location enam
if ($LASTEXITCODE -ne 0) { throw "D1 create failed; stop here" }

$info = npx.cmd wrangler d1 info $name --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $info.name -ne $name -or
    $info.uuid -notmatch '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$' -or
    $info.uuid -in @(
      "26b9ecab-1aaa-4120-93a5-1c409555d28b",
      "a1bf5a75-1bec-4437-92fa-64e69c3da081",
      "134f4884-ba6e-4f6d-88ef-7b3b021c944d"
    )) { throw "DB identity rejected; stop here" }

$config = [ordered]@{
    name = "maltworks-retention-disposable-runner"
    main = "src/index.ts"
    workers_dev = $false
    preview_urls = $false
    d1_databases = @([ordered]@{
        binding = "DB"
        database_name = $name
        database_id = $info.uuid
        migrations_dir = "migrations"
    })
}
$configPath = ".\wrangler.retention-disposable.jsonc"
[System.IO.File]::WriteAllText(
    (Join-Path (Get-Location).Path "wrangler.retention-disposable.jsonc"),
    ($config | ConvertTo-Json -Depth 20),
    (New-Object System.Text.UTF8Encoding($false))
)
Write-Host "Disposable database identity: $($info.name) / $($info.uuid)"

npx.cmd wrangler d1 migrations apply $name --remote --config $configPath
if ($LASTEXITCODE -ne 0) { throw "Disposable migration failed; stop here" }
```

The local `wrangler.retention-disposable.jsonc` is Git-ignored. Never copy the
staging configuration or point its DB binding to the disposable database.

## 2. Seed and inspect

```powershell
$path = "scripts/retention-disposable"
npx.cmd wrangler d1 execute $name --remote --config $configPath --file "$path/01-seed.sql" --yes
if ($LASTEXITCODE -ne 0) { throw "Seed failed" }

$status = (Get-Content "$path/04-status.sql" -Raw) -replace '\s+', ' '
npx.cmd wrangler d1 execute $name --remote --config $configPath --command $status
```

Expected: raw 6, expired 3, preserved recent 3, both archived sums 0, checkpoints
0, latest sequence 6, alarm count 1.

## 3. Demonstrate the block before archiving

```powershell
npx.cmd wrangler d1 execute $name --remote --config $configPath --file "$path/03-prune.sql" --yes
if ($LASTEXITCODE -ne 0) { throw "Guard probe failed" }
npx.cmd wrangler d1 execute $name --remote --config $configPath --command $status
```

All eight status values must remain unchanged, especially raw 6 and expired 3.

## 4. Archive both resolutions, inspect, prune, inspect

```powershell
npx.cmd wrangler d1 execute $name --remote --config $configPath --file "$path/02-rollup.sql" --yes
if ($LASTEXITCODE -ne 0) { throw "Rollup SQL failed" }
npx.cmd wrangler d1 execute $name --remote --config $configPath --command $status

# Before pruning: raw 6, expired 3, recent 3; archives 5 and 5,
# checkpoints 2, latest 6, alarm 1.
# Only proceed if that is exactly what was observed.
npx.cmd wrangler d1 execute $name --remote --config $configPath --file "$path/03-prune.sql" --yes
if ($LASTEXITCODE -ne 0) { throw "Prune failed" }
npx.cmd wrangler d1 execute $name --remote --config $configPath --command $status

# After pruning: raw 3, expired 0, recent 3, archives 5 and 5,
# checkpoints 2, latest 6, alarm 1.
```

**Manual gate:** Do not run the second `03-prune.sql` invocation if any pre-prune
check fails. Submit the results for review instead.

No manual remote D1 operations should be performed against the existing
`maltworks-lab-staging`; its rollup-only Worker continues independently.

## 5. Clean up (after reviewing results)

Delete the disposable database only after confirming its name and UUID with
`wrangler d1 info ... --json`. The deletion is irreversible and must be done
interactively; never use `--skip-confirmation` for this drill.
