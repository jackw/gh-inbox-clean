# Github notifications cleanup

This script uses the GH api to iterate over notifcations and close any for pull requests that have been merged / closed.

You must have the gh cli installed and auth'd for this to work.

## Usage

Clone the repo somewhere.

Make sure you are logged into GH via the gh cli.

`gh auth login`

Then install dependencies and run the script.

`npm i && npm run start`

### Team notifications

To also keep notifications where your team is a requested reviewer, set the `NOTIFICATION_CLEANUP_TEAMS` env var with a comma-separated list of team slugs:

`NOTIFICATION_CLEANUP_TEAMS=my-team,other-team npm run start`
