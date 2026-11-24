import argparse
from concurrent.futures import ThreadPoolExecutor
import base64
import hashlib
import io
import json
from pathlib import Path
import posixpath
import re
import shutil
import tarfile
import tempfile
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent
SITE = ROOT.parent / "sites/christmas-memories"
MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
MODEL_HASH = "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1"
MEDIAPIPE_LICENSE_URL = "https://raw.githubusercontent.com/google-ai-edge/mediapipe/v0.10.3/LICENSE"
MEDIAPIPE_LICENSE_HASH = "8707eef0533987efc5b155d64761eeb6e20793f50b9bd1a68dad1cf4719d0ed8"
PACKAGES = {
    "three.tgz": ("https://registry.npmjs.org/three/-/three-0.160.0.tgz",
                  "DLU8lc0zNIPkM7rH5/e1Ks1Z8tWCGRq6g8mPowdDJpw1CFBJMU7UoJjC6PefXW7z//SSl0b2+GCw14LB+uDhng=="),
    "mediapipe.tgz": ("https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-0.10.3.tgz",
                      "q6yPXKGlANzLUc77X1zN+AKLFTiviCYtRXv5SV27GnbUVw0lsy94ybBmsxIMa+pATWIi0GmmtENJt3k0BAQheA=="),
    "cinzel.tgz": ("https://registry.npmjs.org/@fontsource/cinzel/-/cinzel-5.2.8.tgz",
                   "B9WeF/jPlOJOrcXfX96cy4KfM+s1QcU2C9W2hE3azBOBzPvzFkNpBovT5JmhAeicE/s4HZWKF9LF5hmEcqlbsw=="),
}


def read_asset(name, url, assets_dir):
    if assets_dir:
        return (assets_dir / name).read_bytes()
    with urlopen(url, timeout=90) as response:
        return response.read()


def npm_archive(name, assets_dir):
    url, integrity = PACKAGES[name]
    contents = read_asset(name, url, assets_dir)
    if base64.b64encode(hashlib.sha512(contents).digest()).decode() != integrity:
        raise ValueError(f"Integrity check failed for {name}")
    return tarfile.open(fileobj=io.BytesIO(contents))


def copy_file(archive, name, output):
    output.parent.mkdir(parents=True, exist_ok=True)
    with archive.extractfile("package/" + name) as source, output.open("wb") as target:
        shutil.copyfileobj(source, target)


def bundle_three(assets_dir, destination):
    modules = [
        "build/three.module.js", "examples/jsm/environments/RoomEnvironment.js",
        *[f"examples/jsm/postprocessing/{name}.js" for name in
          ("EffectComposer", "RenderPass", "UnrealBloomPass", "OutputPass")],
    ]
    seen = set()
    with npm_archive("three.tgz", assets_dir) as archive:
        copy_file(archive, "LICENSE", destination / "LICENSE.txt")
        while modules:
            name = modules.pop()
            if name in seen:
                continue
            seen.add(name)
            output = destination / name
            copy_file(archive, name, output)
            for dep in re.findall(r"""(?:from|import)\s*['"](\.[^'"]+)['"]""", output.read_text()):
                modules.append(posixpath.normpath(posixpath.join(posixpath.dirname(name), dep)))


def bundle_mediapipe(assets_dir, destination):
    with npm_archive("mediapipe.tgz", assets_dir) as archive:
        names = [member.name.removeprefix("package/") for member in archive.getmembers() if member.isfile()]
        for name in names:
            if name.startswith("wasm/") or name == "vision_bundle.mjs":
                copy_file(archive, name, destination / name)
        if not (destination / "vision_bundle.mjs").is_file():
            raise ValueError("MediaPipe module missing")
    license_text = read_asset("mediapipe-license.txt", MEDIAPIPE_LICENSE_URL, assets_dir)
    if hashlib.sha256(license_text).hexdigest() != MEDIAPIPE_LICENSE_HASH:
        raise ValueError("Integrity check failed for the MediaPipe license")
    (destination / "LICENSE.txt").write_bytes(license_text)
    model = read_asset("hand_landmarker.task", MODEL_URL, assets_dir)
    if hashlib.sha256(model).hexdigest() != MODEL_HASH:
        raise ValueError("Integrity check failed for the hand model")
    (destination / "hand_landmarker.task").write_bytes(model)


def bundle_font(assets_dir, destination):
    css = []
    with npm_archive("cinzel.tgz", assets_dir) as archive:
        copy_file(archive, "LICENSE", destination / "LICENSE.txt")
        for weight in (400, 500, 600):
            name = f"cinzel-latin-{weight}-normal.woff2"
            copy_file(archive, "files/" + name, destination / name)
            css.append(f'@font-face{{font-family:Cinzel;font-style:normal;font-weight:{weight};'
                       f'font-display:swap;src:url("./{name}") format("woff2")}}')
    (destination / "cinzel.css").write_text("\n".join(css) + "\n")


def write_worker(root):
    html = (SITE / "worker/tree.html").read_text()
    html = re.sub(r'^\s*<link[^\n]*https://fonts\.(?:googleapis|gstatic)\.com[^\n]*\n',
                  "\n", html, flags=re.MULTILINE)
    html = html.replace("</head>", '  <link rel="stylesheet" href="/assets/cinzel/cinzel.css">\n</head>')
    html = html.replace("https://cdn.jsdelivr.net/npm/three@0.160.0/", "/assets/three/")
    html = html.replace("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/+esm",
                        "/assets/mediapipe/vision_bundle.mjs")
    html = html.replace("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm",
                        "/assets/mediapipe/wasm").replace(MODEL_URL, "/assets/mediapipe/hand_landmarker.task")
    if "https://" in html:
        raise ValueError("The page still references an external HTTPS resource")
    target = root / "dist/server/index.js"
    target.parent.mkdir(parents=True, exist_ok=True)
    worker = (SITE / "worker/index.js").read_text()
    target.write_text("const treeHtml = " + json.dumps(html) + ";\n" + worker)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    parser.add_argument("--assets-dir", type=Path)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="christmas-tencent-") as work:
        root = Path(work) / "christmas-memories"
        root.mkdir()
        with ThreadPoolExecutor(max_workers=3) as executor:
            jobs = [executor.submit(task, args.assets_dir, root / "assets" / name) for name, task in
                    [("three", bundle_three), ("mediapipe", bundle_mediapipe), ("cinzel", bundle_font)]]
            for job in jobs:
                job.result()
        write_worker(root)
        for name in ("server.mjs", "import-photos.mjs", "Caddyfile", "README.md"):
            shutil.copyfile(ROOT / name, root / name)
        (root / "package.json").write_text(json.dumps(
            {"name": "christmas-memories", "private": True, "type": "module",
             "engines": {"node": ">=24"}}, indent=2) + "\n")
        with tarfile.open(args.archive, "x:gz") as archive:
            archive.add(root, arcname=root.name)
    print(args.archive.resolve())


if __name__ == "__main__":
    main()
