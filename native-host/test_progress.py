import io
import json
import struct
import sys
from unittest import mock

from test_host import MediaTestCase, host


class ProgressTests(MediaTestCase):
    def test_processing_and_importing_progress_does_not_change_final_counts(self):
        image = self.temporary_file('.jpg')
        events = []
        with (mock.patch.object(host, 'download_image', return_value=(image, self.image_url, 'jpg')),
              mock.patch.object(host, 'import_to_photos', return_value=(True, 1, ''))):
            result = host.process({'images': [{'url': self.image_url}, {'url': 'https://example.org/a'}]}, events.append)
        self.assertEqual((result['saved'], result['failed']), (1, 1))
        self.assertEqual([(event['phase'], event['completed'], event['total']) for event in events],
                         [('download', 0, 2), ('download', 1, 2), ('download', 2, 2),
                          ('import', 0, 1), ('import', 1, 1)])
        self.assertTrue(all(event['event'] == 'progress' for event in events))

    def test_native_protocol_frames_progress_before_the_final_error(self):
        request = json.dumps({'images': [{'url': 'https://example.org/a'}]}).encode()
        output = io.BytesIO()
        with (mock.patch.object(sys, 'stdin', mock.Mock(buffer=io.BytesIO(struct.pack('@I', len(request)) + request))),
              mock.patch.object(sys, 'stdout', mock.Mock(buffer=output))):
            host.main()
        output.seek(0)
        frames = []
        while header := output.read(4):
            frames.append(json.loads(output.read(struct.unpack('@I', header)[0])))
        self.assertEqual([frame.get('event') for frame in frames], ['progress', 'progress', None])
        self.assertFalse(frames[-1]['ok'])
        self.assertEqual(frames[-1]['failed'], 1)
