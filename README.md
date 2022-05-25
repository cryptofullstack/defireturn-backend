# Cost basis server

## Installation

1. Install packages

```shell
yarn
```

2. Install redis

If running on windows, install latest binary from here: https://github.com/microsoftarchive/redis/releases

3. Start server

```shell
yarn start
```

**Swagger url:** `http://localhost:${PORT}/api`

After launch, the console will contain the address where the local server is deployed

## Folder structure

- `controllers` - surface logic of API request processing

- `helpers` - a set of auxiliary functions, in our case these are functions for working with **moralis** and **debank**

- `services` - The main processes that occur on the server in our case is an algorithm for finding the **cost basis**

- `jobs` -working with the **bull.js** is placed in a separate folder

- `proccesors` - it is possible for the future to configure **bull.js** for individual processors

- `routers/api` - classes for routing API requests

- `utils` - auxiliary functions, usually utils can be reused in different projects, since this is a common case of implementations
- `migration` - utils of database migration 
- `cloud` - Moralis Cloud functions

## MongoDB stuff works
    The cloud job in the moralis server runs frequently to update the moralis prices on MongoDB. In cloud functio, we can't use mongoose node module so, we can interact with MongoDB using defireturn server REST API.  So before uploading cloud job function code to moralis server, we should confirm the value of serverURL variable.
    After that, we can use this moralis CLI to upload code to moralis server and then schedule the job running on moralis server dashboard.

## Contributing

I want to describe the development process.

We have basic `main` and `dev` branches. We will build our development process using the gitflow approach.

A separate branch is created for each issue or group of issues. After the work is completed, the branch must be merged into `dev` or make a pull request.

Once `dev` has stable and tested code, we can merge into `main`.

> **NOTE!** Don't forget to get the latest code from dev before creating a new branch.
