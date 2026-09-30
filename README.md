# t-lingual

A small workspace for multilingual conversations and private session records.

## Preview

```console
docker compose -f compose.demo.yaml up -d --build
```

Open `http://localhost:5181`.

## Service

Set the public origin, data directory, and external endpoints in your environment,
then run `docker compose up -d --build`. The container listens on port `8080`.

Optional overlays: add `-f compose.translator.yaml` to join the translator's
network, and `-f compose.gpu.yaml` to let the monitoring page read the GPU
(needs the NVIDIA container runtime; only its read-only utility capability is
granted).
