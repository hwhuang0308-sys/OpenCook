#!/usr/bin/env python3
"""Compiled CLI test using real PTYs and optional loopback RTSP; no model calls or physical devices."""
import argparse
import base64
import json
import os
from pathlib import Path
import pty
import re
import select
import struct
import subprocess
import tempfile
import threading
import time
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('binary', type=Path)
parser.add_argument('--rtsp-url')
parser.add_argument('--ffmpeg', default='')
args = parser.parse_args()
if os.name != 'posix':
    raise SystemExit('PTY device smoke requires Linux or macOS')
binary = str(args.binary.resolve())
with tempfile.TemporaryDirectory(prefix='opencook-device-smoke-') as temporary:
    root = Path(temporary)
    env = dict(os.environ, HOME=temporary, USERPROFILE=temporary, OPENCOOK_TEST_HOME=temporary,
               XDG_CONFIG_HOME=str(root/'config'), XDG_DATA_HOME=str(root/'data'),
               XDG_STATE_HOME=str(root/'state'), XDG_CACHE_HOME=str(root/'cache'),
               OPENCOOK_DB=str(root/'cook.db'), OPENCOOK_CONFIG=str(root/'opencook.json'),
               OPENCOOK_PASSWORD='device-smoke-only', OPENCOOK_DISABLE_PROJECT_CONFIG='1')
    stop = threading.Event()
    ports = {name: pty.openpty() for name in ('temperature', 'sound', 'air')}
    counts = {name: 0 for name in ports}
    temperature = bytearray(1575)
    for pixel in range(768):
        struct.pack_into('<h', temperature, 37 + pixel * 2, 250)
    sound = bytes.fromhex('99000202580000')
    air = bytearray.fromhex('ff1711021234138800')
    air[8] = (256 - (sum(air[1:8]) & 255)) & 255
    def simulate(name):
        master = ports[name][0]
        streaming = False
        while not stop.is_set():
            try:
                readable = select.select([master], [], [], .1)[0]
                if readable:
                    request = os.read(master, 1024)
                    if name == 'temperature' and request:
                        counts[name] += 1
                        os.write(master, temperature)
                    if name == 'sound' and request:
                        counts[name] += 1
                        os.write(master, sound)
                    if name == 'air' and request:
                        streaming = True
                if name == 'air' and streaming:
                    counts[name] += 1
                    os.write(master, air)
            except OSError:
                return
    threads = [threading.Thread(target=simulate, args=(name,), daemon=True) for name in ports]
    for thread in threads:
        thread.start()
    process = subprocess.Popen([binary, 'serve', '--port', '0'], cwd=root, env=env,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    try:
        deadline = time.monotonic() + 30
        url = None
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError('Compiled service exited before readiness')
            if not select.select([process.stdout], [], [], .2)[0]:
                continue
            match = re.search(r'server listening on (http://\S+)', process.stdout.readline())
            if match:
                url = match.group(1)
                break
        if not url:
            raise RuntimeError('Compiled service did not become ready')
        def call(route, payload=None):
            request = urllib.request.Request(url + '/api/kitchen/' + route,
                data=json.dumps(payload).encode() if payload is not None else None,
                method='PUT' if payload is not None else 'GET',
                headers={'content-type': 'application/json', 'authorization': 'Basic ' +
                         base64.b64encode(b'opencook:device-smoke-only').decode()})
            with urllib.request.urlopen(request, timeout=10) as response:
                return json.load(response)
        def until(check, description, seconds=20):
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                if check():
                    return
                if process.poll() is not None:
                    raise RuntimeError('Compiled service exited')
                time.sleep(.1)
            raise RuntimeError(description)
        settings = call('settings')
        assert not settings['recording']['enabled'], 'Debug must default off'
        devices = settings['devices']
        for name in ports:
            devices[name].update(enabled=True, port=os.ttyname(ports[name][1]))
        if args.rtsp_url:
            devices['camera'].update(enabled=True, rtsp_url=args.rtsp_url, ffmpeg_path=args.ffmpeg)
        call('devices', {'devices': devices})
        active = list(ports) + (['camera'] if args.rtsp_url else [])
        def connected():
            states = {state['id']: state for state in call('status')}
            return all(states[name]['state'] == 'connected' for name in active)
        until(lambda: connected() and min(counts.values()) >= 3, 'Devices did not sample successfully')
        states = {state['id']: state for state in call('status')}
        assert abs(states['temperature']['value'] - 25) < .001
        assert states['sound']['value'] == 60
        assert abs(states['air']['value'] - 46.6) < .001
        assert not Path(settings['recording']['directory']).exists(), 'Debug-off wrote sensor data'
        print('Compiled sensors: temperature=25 C, sound=60 dB, air=46.6 mg/m3; default debug writes=0', flush=True)
        debug = root/'debug'
        call('recording', {'enabled': True, 'directory': str(debug)})
        def recorded():
            required = [('temperature', '*.csv'), ('temperature', '*.png'), ('sound', '*.jsonl'), ('air', '*.jsonl')]
            if args.rtsp_url:
                required.append(('camera', '*.jpg'))
            return all(any((debug/name).glob(pattern)) for name, pattern in required)
        until(recorded, 'Compiled image or sensor debug assets could not record', 30)
        print('Debug-on: temperature CSV/PNG and scalar JSONL verified' + ('; RTSP and camera JPEG verified' if args.rtsp_url else ''), flush=True)
        call('recording', {'enabled': False, 'directory': str(debug)})
        time.sleep(.3)
        snapshot = {str(file): file.stat().st_mtime_ns for file in debug.rglob('*') if file.is_file()}
        time.sleep(1.2)
        assert snapshot == {str(file): file.stat().st_mtime_ns for file in debug.rglob('*') if file.is_file()}, 'Debug-off kept recording'
        blocked = root/'not-a-directory'
        blocked.write_text('fixture')
        call('recording', {'enabled': True, 'directory': str(blocked)})
        before = counts['temperature']
        until(lambda: connected() and counts['temperature'] >= before + 3, 'Debug write failures stopped sampling')
        print('Debug-off stops writes; debug write failures preserve sampling', flush=True)
        for name in ports:
            devices[name]['enabled'] = False
        devices['camera']['enabled'] = False
        call('devices', {'devices': devices})
        expected = {name: 'disabled' for name in ports}
        expected['camera'] = 'disabled' if args.rtsp_url else 'unconfigured'
        until(lambda: all(state['state'] == expected[state['id']] for state in call('status')),
              'Stopped devices did not report disabled or unconfigured status')
        print('Disabled device status verified', flush=True)
    finally:
        stop.set()
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        for thread in threads:
            thread.join(timeout=2)
        for master, slave in ports.values():
            os.close(master)
            os.close(slave)
