# LCOV report action

Reports LCOV coverage on pull requests. Optimized for Elixir projects (line coverage only).

## Usage

```yaml
- uses: allocator-one/lcov-report-action@v1
  with:
    lcov-file: cover/lcov.info
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `lcov-file` | Yes | - | Path to lcov.info |
| `github-token` | Yes | - | GitHub token |
| `all-files-minimum-coverage` | No | `0` | Min coverage % for all files |
| `changed-files-minimum-coverage` | No | `0` | Min coverage % for changed files |
| `test-summary-file` | No | - | Path to test summary file to include in report |

## Development

Edit and rebuild:

```bash
npm install
# Edit index.js
npm run build
git add index.js dist/
git commit -m "Update lcov-report action"
```

---

Inspired by [kefasjw/lcov-pull-request-report](https://github.com/kefasjw/lcov-pull-request-report).
