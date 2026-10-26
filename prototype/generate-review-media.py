"""Generate a silent local player-review clip from the credited prototype covers."""
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent
output = root / "public" / "preview-media"
output.mkdir(exist_ok=True)
command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
for cover in ("mountain", "city", "sky", "tech"):
    command += ["-loop", "1", "-framerate", "24", "-t", "5", "-i", str(root / "public" / "covers" / f"{cover}.jpg")]
filters = []
for index in range(4):
    filters.append(
        f"[{index}:v]scale=1280:720:force_original_aspect_ratio=increase,"
        "crop=1280:720,setsar=1,"
        "zoompan=z='min(zoom+0.0004,1.05)':d=1:s=1280x720:fps=24,"
        f"setpts=PTS-STARTPTS[v{index}]"
    )
filters.append("[v0][v1][v2][v3]concat=n=4:v=1:a=0[out]")
command += ["-filter_complex", ";".join(filters), "-map", "[out]", "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "24", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output / "review.mp4")]
subprocess.run(command, check=True)
print(f"Generated {output / 'review.mp4'}")
