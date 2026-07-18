# Third-party notices

ScryPuppy can optionally download and run the components below after an explicit user action. The application installer does not contain the embedding model.

## FastEmbed

- Project: `fastembed-rs`
- Version used by this source tree: 5.17.3
- Copyright: Qdrant and contributors
- License: Apache License 2.0
- Source and license: <https://github.com/Anush008/fastembed-rs>

## Multilingual E5 Small

- Model: `intfloat/multilingual-e5-small`
- Copyright: Microsoft Corporation and model contributors
- License: MIT
- Model card and license: <https://huggingface.co/intfloat/multilingual-e5-small>

The model is downloaded into the user's ScryPuppy application-data directory only when the user selects **Download model**. Removing the model from Settings deletes that downloaded cache but preserves captures and generated search embeddings.
