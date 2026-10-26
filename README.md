# bb-plugins

Yasser's custom bb plugins. Each plugin lives in `plugins/<name>/` with its own
`package.json`, and `.bb/plugins.json` indexes them.

| Plugin | What it does |
| --- | --- |
| [checklist](plugins/checklist) | A live per-thread checklist the agent keeps with `todo_write`. |

## Work on a plugin

```sh
cd plugins/<name>
npm install
npm test
bb plugin build
bb plugin install .     # path install; re-run after moving the directory
```

## Add a plugin

```sh
cd plugins && bb plugin new <name> && mv bb-plugin-<name> <name>
```

Then add `{ "name": "<name>", "source": "./plugins/<name>" }` to
`.bb/plugins.json` and a row to the table above.

## Install from git (once pushed)

```sh
bb plugin install git:<repo-url>@master --plugin <name>
```
