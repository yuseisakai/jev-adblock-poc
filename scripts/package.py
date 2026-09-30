"""Build a reproducible, allowlisted unpacked-extension ZIP (Python 3, stdlib only)."""
from pathlib import Path
import hashlib
import json
import re
import zipfile

root = Path(__file__).resolve().parent.parent
source = root / "dist"
manifest = json.loads((source / "manifest.json").read_text(encoding="utf-8"))
version = manifest["version"]
if not re.fullmatch(r"\d+(?:\.\d+){1,3}", version):
    raise ValueError("Invalid extension version")
files = ["manifest.json", "LICENSE", "PRIVACY.md", "THIRD_PARTY_NOTICES.md", "INSTALL.md"]
files += ["src/" + name for name in (
    "background.js", "content.js", "core.js", "options.html", "options.js",
    "popup.html", "popup.js", "settings-ui.js", "ui.css", "ui.js"
)]
files += [f"src/icons/icon-{size}.png" for size in (16, 32, 48, 128)]
actual = {p.relative_to(source).as_posix() for p in source.rglob("*") if p.is_file()}
if actual != set(files):
    raise ValueError("Unexpected or missing distribution files; review the packaging allowlist")
output = root / "releases"
output.mkdir(exist_ok=True)
archive = output / ("Jev-Ad-blocker-" + version + ".zip")
with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as z:
    for name in sorted(files):
        item = source / name
        if item.is_symlink():
            raise ValueError("Symlinks are not allowed in the distribution")
        entry = zipfile.ZipInfo("Jev-Ad-blocker/" + name, date_time=(2026, 1, 1, 0, 0, 0))
        entry.compress_type = zipfile.ZIP_DEFLATED
        entry.create_system = 3
        entry.external_attr = 0o100644 << 16
        z.writestr(entry, item.read_bytes())
with zipfile.ZipFile(archive) as z:
    if z.testzip() is not None:
        raise ValueError("ZIP integrity check failed")
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
archive.with_suffix(".zip.sha256").write_text(digest + "  " + archive.name + "\n", encoding="utf-8")
print(f"Created {archive.name}: {len(files)} files, {archive.stat().st_size} bytes")
print("SHA256 " + digest)
