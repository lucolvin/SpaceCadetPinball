"""Unpack the game files from a built SpaceCadetPinball.data, using the file table in SpaceCadetPinball.js."""
import json
import os
import re
import sys

js, data, out = sys.argv[1:4]
meta = json.loads(re.search(r'loadPackage\((\{"files".*?\})\)', open(js, errors="ignore").read()).group(1))
blob = open(data, "rb").read()
for f in meta["files"]:
    path = os.path.join(out, os.path.basename(f["filename"]))
    with open(path, "wb") as o:
        o.write(blob[f["start"]:f["end"]])
print(len(meta["files"]), "files")
