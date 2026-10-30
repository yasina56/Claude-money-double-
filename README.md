# Claude-money-double-

A procedural Blender animation: **$1 that doubles every hour for 24 hours**. Each hour, it shows a 3D model of something the balance can buy, from a $1 lollipop to a $16.7M superyacht.

- [`STORYBOARD.md`](STORYBOARD.md) has the full storyboard: the purchase table, pacing, transitions, HUD layout, limitations and price notes.
- [`money_doubling.py`](money_doubling.py) is the data-driven Blender Python generator. It needs no external assets.

```bash
python3 money_doubling.py --table                 # print the hour/price/frame table
blender -b -P money_doubling.py -- --render       # render money_doubling.mp4 (1080x1920, ~46 s)
```

Optional: put licensed models in `assets/<name>.glb` to replace individual procedural models. See STORYBOARD.md §6.
