# UI acceptance issues

| Scene | Observation | Cause / action | Recapture status |
| --- | --- | --- | --- |
| All paired reference scenes | No local VS Code 1.142.0 capture | Official binary download TLS handshake fails; obtain and verify the fixed binary, then capture identical fixture/DPI/focus | Open; no visual acceptance |
| Tab bar | Windows native horizontal scrollbar is visible with overflowing tabs | Custom scrollbar/overflow behavior needs reference comparison | Release capture retained; open |
| Search results | File grouping differs from the required nested directory tree | Implement directory nodes and folder result operations | Open |
| Quick Open / Quick Search | No live result preview | Complete preview/restore behavior before comparing focus and selection | Open |
| Editor groups | Equal widths; no draggable group divider | Implement group resizing and persisted relative sizes | Open |
| DPI / native UI | Captured devicePixelRatio about 2.22, not the required 100% base scene | Repeat at controlled 100% scale, then high-DPI, IME, pickers and multiple displays | Open |

Release captures 01–08 are taken through WebDriver from the actual Release executable. They are behavioral/development evidence, not successful comparison pairs. Historical failure captures remain labeled failure.
