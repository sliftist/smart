#!/bin/sh
sleep 15

PATH=/usr/local/bin:/usr/bin:/bin:$PATH
export PATH

if ! screen -ls | grep -q "\.watch"; then
  screen -dmS watch
  sleep 0.5
fi
# No kill, so it doesn't kill itself
screen -S watch -X stuff 'cd ~/smart && yarn watch\n'

if ! screen -ls | grep -q "\.thermostat"; then
  screen -dmS thermostat
  sleep 0.5
fi
screen -S thermostat -X stuff '^C^C^C\n'
screen -S thermostat -X stuff 'cd ~/smart && yarn thermostat\n'

if ! screen -ls | grep -q "\.humid"; then
  screen -dmS humid
  sleep 0.5
fi
screen -S humid -X stuff '^C^C^C\n'
screen -S humid -X stuff 'cd ~/smart && yarn humid\n'