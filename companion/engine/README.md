# LRC Editor AI Aligner Engine

[中文说明](./README-zh.md)

This directory contains the minimal, pinned engine snapshot distributed with the optional local AI alignment companion for [LRC Editor](https://lrc.sgmy.org).

It includes only the Python package and local service assets required at runtime. Training data, benchmarks, development outputs, test fixtures, and the source repository history are not part of this distribution.

The companion installer creates a private Python environment, downloads models from their official sources, and links model and task-cache directories outside this engine directory. The web application never uploads local audio or lyrics to the LRC Editor website.

## License

MIT License. See [LICENSE](./LICENSE).
