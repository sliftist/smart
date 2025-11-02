#!/bin/sh
sleep 15

PATH=/usr/local/bin:/usr/bin:/bin:$PATH
export PATH

killall screen
sleep 1

screen -dmS thermostat
screen -S thermostat -X stuff 'cd ~/smart && yarn thermostat\n'

screen -dmS humid
screen -S humid -X stuff 'cd ~/smart && yarn humid\n'