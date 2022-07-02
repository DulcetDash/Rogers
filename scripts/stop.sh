#!/bin/bash

(cd /home/ec2-user/Rogers ; docker-compose down)
docker system prune --all --force