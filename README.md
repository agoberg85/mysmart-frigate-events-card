# MySmart Frigate Events Card

A custom Lovelace card for Home Assistant to display and interact with Frigate events.

## Support development
Buy me a coffee: https://buymeacoffee.com/mysmarthomeblog

Subscribe to Youtube channel: https://www.youtube.com/@My_Smart_Home

## Features
- **Native Playback:** Plays Frigate HLS video streams natively within the card.
- **Filtering:** Filter clips by Camera, Label, and Date (Today, Yesterday, Past Week, All Time).
- **Responsive Layout:** Automatically adjusts the grid between 2 and 5 columns depending on the screen width.
- **Performance:** Implements virtual scrolling and lazy-loads thumbnails to handle a large number of events smoothly.

## Installation

### HACS (Recommended)
1.  Go to the HACS page in your Home Assistant instance.
2.  Click the three-dot menu in the top right.
3.  Select "Custom repositories".
4.  In the "Repository" field, paste the URL of this repository (https://github.com/agoberg85/mysmart-frigate-events-card).
5.  For "Category", select "Dashboard".
6.  Click "Add".
7.  The `mysmart-frigate-events-card` will now appear in the HACS Frontend list. Click "Install".

### Manual Installation
1.  Download the `mysmart-frigate-events-card.js` file from the latest release.
2.  Copy the file to the `www` directory in your Home Assistant `config` folder.
3.  In your Lovelace dashboard, go to "Manage Resources" and add a new resource:
    - URL: `/local/mysmart-frigate-events-card.js`
    - Resource Type: `JavaScript Module`

## Configuration

### Main Options
| Name | Type | Required? | Description | Default |
| :--- | :--- | :--- | :--- | :--- |
| `type` | string | **Required** | `custom:mysmart-frigate-events-card` | |
| `entities` | list | **Required** | A list of camera entities to display events for. Alternatively, a single `entity` can be provided. | |
| `title` | string | Optional | The title of the card. | `'Security Feed'` |
| `limit` | number | Optional | The total limit of events. | `50` |
| `columns` | number | Optional | The number of columns for the grid. | `3` |
| `virtualScrolling` | boolean | Optional | Enable virtual scrolling for performance. | `true` |
| `card_height` | string | Optional | Height of the card (e.g., `500px` or `80vh`). | `''` |
| `clipsPerLoad` | number | Optional | Number of clips to load at a time per camera. | `10` |
