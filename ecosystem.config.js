module.exports = {
  apps: [
    {
      name: "Events gateway",
      script: "server.js",
      instances: 2,
      autorestart: true,
      watch: false,
      max_memory_restart: "3G",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "Pricing service",
      script: "pricingService.js",
      instances: 2,
      autorestart: true,
      watch: false,
      max_memory_restart: "3G",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "Search service",
      script: "searchService.js",
      instances: 2,
      autorestart: true,
      watch: false,
      max_memory_restart: "3G",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "SMS service",
      script: "SMS/app.js",
      instances: 2,
      autorestart: true,
      watch: false,
      max_memory_restart: "3G",
      env: {
        NODE_ENV: "production",
      },
    },
    // ,
    // {
    //   name: "Smart cache service",
    //   script: "SmartCacher.js",
    //   instances: 1,
    //   autorestart: true,
    //   watch: false,
    //   max_memory_restart: "4G",
    //   env: {
    //     NODE_ENV: "production",
    //   },
    // },
  ],
};
