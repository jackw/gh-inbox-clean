# Github notifications cleanup

This script uses the GH api to iterate over notifcations and close any for pull requests that have been merged / closed.

You must have the gh cli installed and auth'd for this to work.

## Usage

Clone the repo somewhere.

Make sure you are logged into GH via the gh cli.

`gh auth login`

Then install dependencies and run the script.

`npm i && npm run start`
