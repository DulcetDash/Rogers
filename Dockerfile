FROM node:latest

ADD . /app/
WORKDIR /app
RUN rm .env
#Production
RUN mv .env_live .env
#Development
# RUN mv .env_dev .env

RUN npm install yarn -g --force

#NPM install for the SMS service
WORKDIR /SMS
RUN yarn install --network-timeout 100000

WORKDIR /app


RUN npm install pm2 -g
RUN pm2 install pm2-logrotate
RUN pm2 set pm2-logrotate:max_size 500Mb
RUN yarn install --network-timeout 100000
RUN pm2 startup

EXPOSE 9697
EXPOSE 9595
EXPOSE 9898
EXPOSE 9696
EXPOSE 9393

CMD [ "pm2-runtime", "ecosystem.config.js" ]