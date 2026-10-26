"""Generate migration fixtures by executing selected definitions from the original project.

Usage: python script/sensor-reference.py /path/to/original/OpenCook > test/fixture/sensors.json
Only AST-selected definitions execute: importing the legacy modules would start devices
and create recording directories. This script is a test oracle, not a runtime dependency.
"""
import ast
import hashlib
import io
import json
import struct
import sys
import time
from collections import deque
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, Optional

import cv2
import numpy as np


root = Path(sys.argv[1])
hashes = {}


def definitions(filename, names, extra=None):
    source = (root / filename).read_bytes()
    hashes[filename] = hashlib.sha256(source).hexdigest()
    parsed = ast.parse(source.decode("utf-8-sig"))
    selected = [node for node in parsed.body if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in names]
    assert len(selected) == len(names)
    namespace = dict(np=np, cv2=cv2, deque=deque, Optional=Optional, Dict=Dict, Any=Any, time=time, struct=struct)
    namespace.update(extra or {})
    exec(compile(ast.Module(body=selected, type_ignores=[]), filename, "exec"), namespace)
    return namespace


air = definitions("cook_air.py", ["_calculate_checksum", "_build_switch_active_cmd", "_parse_active_frame"], dict(MODE_ACTIVE=0x40, CMD_SWITCH_MODE=0x78))
temperature = definitions("cook_temperature_new.py", ["crc16", "_parse_frame_to_matrix", "Temperature_Monitor"], dict(FRAME_LEN=7 + 768 * 2 + 16 * 2))


class Serial:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def reset_input_buffer(self):
        self.calls.append(["flush"])

    def write(self, data):
        self.calls.append(["write", bytes(data).hex()])

    def read(self, count):
        self.calls.append(["read", count])
        return self.response[:count]


serial = Serial(bytes.fromhex("99000202580000"))  # Original accepts incorrect address/function/CRC.
audio = definitions("cook_audio_new.py", ["_crc16", "_read_once_db"], dict(_ser=serial, time=SimpleNamespace(sleep=lambda duration: serial.calls.append(["sleep", duration]))))
sound = dict(value=audio["_read_once_db"](), calls=serial.calls)

raw = [((index * 83 + 17000) % 65536) - 32768 for index in range(768)]
frame = bytes(37) + struct.pack("<768h", *raw) + bytes(2)
matrix = temperature["_parse_frame_to_matrix"](frame)
assert matrix is not None
monitor = temperature["Temperature_Monitor"]()
cases = []
for name, values in [
    ("wire", matrix),
    ("equal", np.full((24, 32), 80.1, dtype=np.float32)),
    ("center", np.fromfunction(lambda y, x: np.where((y - 11.5) ** 2 + (x - 15.5) ** 2 <= 16, 200.3, 50.7), (24, 32)).astype(np.float32)),
    ("left", np.fromfunction(lambda y, x: np.where((y < 11.5) & (x < 15.5), 200.3, 50.7), (24, 32)).astype(np.float32)),
]:
    region, scores, counts = monitor._get_hottest_region_in_ellipse(values)
    k = max(1, int(values.size * 0.1))
    cases.append(dict(name=name, matrix=values.flatten().tolist(), region=region, scores=scores, counts=counts, top_mean=float(np.mean(np.partition(values.flatten(), -k)[-k:]))))

active = bytearray.fromhex("ff17110212341388ff")
active[8] = air["_calculate_checksum"](active)
air_value = air["_parse_active_frame"](bytes(active))
air_value.pop("ts")


def picture(variant):
    y, x, c = np.indices((1020, 1520, 3), dtype=np.int32)
    base = ((x * 13 + y * 7 + c * 47 + (x * y) % 97) % 256).astype(np.uint8)
    if variant == "inverted":
        return 255 - base
    if variant == "changed":
        return ((base.astype(np.uint16) + (x * 11 + y * 3) % 91) % 256).astype(np.uint8)
    return base


vision = []
original = picture("same")
for variant in ["same", "inverted", "changed"]:
    current = picture(variant)
    a = cv2.GaussianBlur(cv2.cvtColor(current[70:1010, 420:1500], cv2.COLOR_BGR2GRAY), (5, 5), 0)
    b = cv2.GaussianBlur(cv2.cvtColor(original[70:1010, 420:1500], cv2.COLOR_BGR2GRAY), (5, 5), 0)
    score = float(cv2.matchTemplate(a, b, cv2.TM_CCOEFF_NORMED)[0, 0])
    temperature.update(cam=SimpleNamespace(get_picture=lambda copy: current, get_picture_seconds_ago_strict=lambda lag, copy: original), open=lambda *args, **kwargs: io.StringIO(), save_path_temp="unused")
    instance = temperature["Temperature_Monitor"]()
    with redirect_stdout(io.StringIO()):
        results = [instance.process_frame(matrix, roi_x1=420, roi_y1=70, roi_x2=1500, roi_y2=1010)[0] for _ in range(6)]
    vision.append(dict(variant=variant, score=score, decisions=results))

json.dump(dict(source_sha256=hashes, python=sys.version.split()[0], numpy=np.__version__, opencv=cv2.__version__, sound=sound, temperature=dict(frame=frame.hex(), request=(bytes.fromhex("016500000311") + struct.pack("<H", temperature["crc16"](bytes.fromhex("016500000311")))).hex(), cases=cases), air=dict(request=air["_build_switch_active_cmd"]().hex(), frame=active.hex(), value=air_value), vision=vision), sys.stdout, ensure_ascii=False, indent=2)
