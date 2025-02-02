//Template

module.exports = {
  apps: [
    {
      name: "Events gateway",
      script: "server.js",
      instances: 1,
      autorestart: true,
      watch: true,
      max_memory_restart: "3G",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "Pricing service",
      script: "pricingService.js",
      instances: 1,
      autorestart: true,
      watch: true,
      max_memory_restart: "3G",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "Search service",
      script: "searchService.js",
      instances: 1,
      autorestart: true,
      watch: true,
      max_memory_restart: "3G",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "Accounts service",
      script: "serverAccounts.js",
      instances: 1,
      autorestart: true,
      watch: true,
      max_memory_restart: "3G",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "Dispatch service",
      script: "serverDispatch.js",
      instances: 1,
      autorestart: true,
      watch: true,
      max_memory_restart: "3G",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "Map service",
      script: "serverMap.js",
      instances: 1,
      autorestart: true,
      watch: true,
      max_memory_restart: "3G",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "Map delivery service",
      script: "serverMap_delivery.js",
      instances: 1,
      autorestart: true,
      watch: true,
      max_memory_restart: "3G",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "Map shopping service",
      script: "serverMap_shopping.js",
      instances: 1,
      autorestart: true,
      watch: true,
      max_memory_restart: "3G",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "SMS service",
      script: "SMS/app.js",
      instances: 1,
      autorestart: true,
      watch: true,
      max_memory_restart: "3G",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
