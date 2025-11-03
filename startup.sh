#!/bin/sh
sleep 15

PATH=/usr/local/bin:/usr/bin:/bin:$PATH
export PATH

if ! screen -ls | grep -q "\.watch"; then
  screen -dmS watch
  sleep 0.5
  screen -S watch -X stuff 'cd ~/smart && yarn watch\n'
fi
# No kill, so it doesn't kill itself

if ! screen -ls | grep -q "\.thermostat"; then
  screen -dmS thermostat
  sleep 0.5
  # killing breaks rtl
  screen -S thermostat -X stuff 'cd ~/smart && yarn thermostat\n'
fi
if ! screen -ls | grep -q "\.humid"; then
  screen -dmS humid
  sleep 0.5
fi
screen -S humid -X stuff '^C^C^C\n'
sleep 2
screen -S humid -X stuff 'cd ~/smart && yarn humid\n'