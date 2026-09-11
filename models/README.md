# Model checkpoints

This directory holds the two trained checkpoints. They total **~1.1 GB**, far past
GitHub's 100 MB per-file limit, so the `.pth` files are excluded by `.gitignore` and
only this README is tracked.

| File | Architecture | Classes | Size | Role |
|---|---|---|---|---|
| `best_epoch_4_acc_98.70.pth` | EfficientNet-B3 (timm) | 91 | ~131 MB | Backup model |
| `vit_b16_epoch_02 (2).pth` | ViT-B/16, 384px (timm) | 91 | ~1.0 GB | Primary model |

## Local development

Checkpoints and data files live at the **workspace root**, not under `backend/`.
Copy both `.pth` files into this directory and the app finds them automatically.

```
models/
├── best_epoch_4_acc_98.70.pth
└── vit_b16_epoch_02 (2).pth

data/
├── class_names.json
├── disease_info.json
├── disease_info_ext.json
└── names (3).json
```

Both locations are resolved through settings, so a deployment that wants a different
layout sets two environment variables and nothing else changes:

```env
MODELS_DIR=D:\Crop_Diseases_Prediction\models      # default: <repo_root>/models
DATA_DIR=D:\Crop_Diseases_Prediction\data          # default: <repo_root>/data
```

## Deployed hosts (Render, Docker, a fresh clone)

Checkpoint management — training, fine-tuning, and remote checkpoint download — is
**out of scope for this release**. The app consumes only the two checkpoints already
present under `models/`; nothing is fetched over the network at boot.

Place both files into `MODELS_DIR` as part of provisioning the host: bake them into
the image, mount a volume, or copy them in before the first boot.

`backend/app/services/model_registry.py` loads whatever is present. A missing or
unreadable checkpoint is logged, that model is marked unavailable, and startup
continues — so the app still serves with one model, reported as `degraded` by
`GET /api/health`.

## Label spaces

The two checkpoints were trained on **different datasets** and do not share a label
vocabulary. Each carries 91 labels:

- `best_epoch_4_acc_98.70.pth` → `data/class_names.json`
- `vit_b16_epoch_02 (2).pth` → `data/names (3).json`

`backend/app/services/label_resolver.py` reconciles both onto a shared canonical
`(crop, disease)` vocabulary. Measured against the current data files:

| Figure | Value |
|---|---|
| Labels per checkpoint | 91 |
| Recommendation records (`disease_info.json` + `disease_info_ext.json`) | 140 |
| Distinct canonical `(crop, disease)` pairs | 133 |

The 140 records exceed the 133 pairs because a few records are near-duplicates
(`Cotton_Healthy_Leaf` / `Cotton_Healthy_Plant`, `Pepper` / `Bell Pepper`).

Swapping a checkpoint means updating its label file too.
