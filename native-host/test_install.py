import importlib.util
import json
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


class InstallationTests(unittest.TestCase):
    def installer(self):
        path = Path(__file__).with_name('install.py')
        self.assertTrue(path.exists(), '缺少可隔离验证的安装实现')
        spec = importlib.util.spec_from_file_location('rednote_install', path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_compilation_failure_preserves_existing_installation(self):
        installer = self.installer()
        with tempfile.TemporaryDirectory() as root:
            support = Path(root) / '旧连接器'
            support.mkdir()
            (support / 'host.py').write_text('old host')
            (support / 'live-photo-helper').write_text('old helper')
            manifest = Path(root) / 'manifest.json'
            manifest.write_text('old manifest')
            with mock.patch.object(installer, 'build_helper', side_effect=subprocess.CalledProcessError(1, 'swiftc')):
                with self.assertRaises(subprocess.CalledProcessError):
                    installer.install(Path(__file__).parent, support, manifest, Path(sys.executable))
            self.assertEqual((support / 'host.py').read_text(), 'old host')
            self.assertEqual((support / 'live-photo-helper').read_text(), 'old helper')
            self.assertEqual(manifest.read_text(), 'old manifest')
            self.assertEqual({path.name for path in Path(root).iterdir()}, {'旧连接器', 'manifest.json'})

    def test_successful_install_uses_fixed_python_and_speaks_native_protocol(self):
        installer = self.installer()
        with tempfile.TemporaryDirectory() as root:
            support = Path(root) / "连接器 with ' quotes"
            manifest = Path(root) / 'hosts' / 'manifest.json'
            def compile_helper(source, output):
                output.write_text('#!/bin/sh\nexit 0\n')
            with mock.patch.object(installer, 'build_helper', side_effect=compile_helper):
                installer.install(Path(__file__).parent, support, manifest, Path(sys.executable))
            config = json.loads(manifest.read_text())
            self.assertEqual(config['allowed_origins'], ['chrome-extension://doklnnbjpnipnicbiecefbchkhmckcbm/'])
            payload = json.dumps({'action': 'status'}).encode()
            response = subprocess.run([config['path']], input=struct.pack('@I', len(payload)) + payload,
                                      capture_output=True, check=True, timeout=5).stdout
            length = struct.unpack('@I', response[:4])[0]
            result = json.loads(response[4:])
            self.assertEqual(length, len(response[4:]))
            self.assertEqual(result, {'ok': True, 'protocolVersion': 2})

    def test_manifest_failure_rolls_back_connector(self):
        installer = self.installer()
        with tempfile.TemporaryDirectory() as root:
            support = Path(root) / 'connector'
            support.mkdir()
            (support / 'host.py').write_text('old host')
            manifest = Path(root) / 'manifest.json'
            manifest.write_text('old manifest')
            def compile_helper(source, output):
                output.write_text('helper')
            replace = installer.os.replace
            def fail_manifest(source, destination):
                if Path(destination) == manifest:
                    raise OSError('清单写入失败')
                return replace(source, destination)
            with (mock.patch.object(installer, 'build_helper', side_effect=compile_helper),
                  mock.patch.object(installer.os, 'replace', side_effect=fail_manifest)):
                with self.assertRaisesRegex(OSError, '清单写入失败'):
                    installer.install(Path(__file__).parent, support, manifest, Path(sys.executable))
            self.assertEqual((support / 'host.py').read_text(), 'old host')
            self.assertEqual(manifest.read_text(), 'old manifest')

    def test_missing_developer_tools_gives_actionable_error_before_install(self):
        installer = self.installer()
        with (mock.patch.object(installer.subprocess, 'run', return_value=mock.Mock(returncode=1)),
              mock.patch.object(installer, 'install') as install,
              mock.patch('sys.stderr')):
            with self.assertRaises(SystemExit) as error:
                installer.main()
        self.assertEqual(error.exception.code, 1)
        install.assert_not_called()

    def test_compiler_receives_selected_macos_sdk(self):
        installer = self.installer()
        with tempfile.TemporaryDirectory() as root:
            commands = []
            def run(command, **kwargs):
                commands.append(command)
                if command[0] == '/usr/bin/xcrun':
                    return mock.Mock(stdout='/compiler/swiftc\n' if '--find' in command else '/SDK/MacOSX.sdk\n')
                if '-sdk' not in command:
                    raise subprocess.CalledProcessError(1, command, stderr="unable to load standard library for target 'arm64-apple-macosx27.0.0'")
                self.assertEqual(command[command.index('-sdk') + 1], '/SDK/MacOSX.sdk')
                Path(command[-1]).write_text('helper')
            with mock.patch.object(installer.subprocess, 'run', side_effect=run):
                installer.install(Path(__file__).parent, Path(root)/'support', Path(root)/'manifest.json', Path(sys.executable))
            self.assertEqual(commands[-1][0], '/compiler/swiftc')
