# opfslogd

Browser logging library built on [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) and [Dedicated Workers](https://developer.mozilla.org/en-US/docs/Web/API/Worker), with [Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) for cross-tab coordination.

> Work in progress.

## Install

```sh
pnpm add opfslogd
```

## Development

```sh
pnpm install
pnpm test        # run tests
pnpm typecheck   # type check
pnpm build       # build to dist/
pnpm lint:pkg    # validate package.json exports
```

## License

MIT
