// import * as core from "@actions/core";
// import * as github from "@actions/github";
// import * as semver from "semver";

const core   = require("@actions/core");
const github = require("@actions/github");
const semver = require("semver");

const owner = github.context.payload.repository.owner.login;
const repo = github.context.payload.repository.name;

async function checkTag(octokit, tagName) {
    const { data } = await octokit.repos.listTags({
        owner,
        repo
    });

    if (data) {
        const result = data.filter(tag => tag.name === tagName);

        if (result.length) {
            return true;
        }
    }

    return false;
}

async function getLatestTag(octokit, boolAll = true) {
    const { data } = await octokit.repos.listTags({
        owner,
        repo
    });

    // ensure the highest version number is the last element
    // strip all non version tags
    const allVTags = data
        .filter(tag => semver.clean(tag.name) !== null);

    allVTags
        .sort((a, b) => semver.compare(semver.clean(a.name), semver.clean(b.name)));

    if (boolAll) {
        return allVTags.pop();
    }

    // filter prereleases
    // core.info("filter only main releases");

    const filtered = allVTags.filter((b) => semver.prerelease(b.name) === null);
    const result = filtered.pop();

    return result;
}

async function loadBranch(octokit, branch) {
    const result = await octokit.rest.git.listMatchingRefs({
        owner,
        repo,
        ref: `heads/${branch}`
    });

    // core.info(`branch data: ${ JSON.stringify(result.data, undefined, 2) } `);
    return result.data.shift();
}

async function checkMessages(octokit, branchHeadSha, tagSha, issueTags) {
    const sha = branchHeadSha;

    // core.info(`load commits since ${sha}`);

    let releaseBump = "none";

    const result = await octokit.rest.repos.listCommits({
        owner,
        repo,
        sha
    });

    if (!(result && result.data)) {
        return releaseBump;
    }

    const wip   = new RegExp("#wip\\b");
    const major = new RegExp("#major\\b");
    const minor = new RegExp("#minor\\b");
    const patch = new RegExp("#patch\\b");

    const fix   = new RegExp("fix(?:es)? #\\d+");
    const matcher = new RegExp(/fix(?:es)? #(\d+)\b/);

    for (const commit of result.data) {
        // core.info(commit.message);
        const message = commit.commit.message;

        if (commit.sha === tagSha) {
            break;
        }
        // core.info(`commit is : "${JSON.stringify(commit.commit, undefined, 2)}"`);
        // core.info(`message is : "${message}" on ${commit.commit.committer.date} (${commit.sha})`);

        if (wip.test(message)) {
            // core.info("found wip message, skip");
            continue;
        }

        if (major.test(message)) {
            // core.info("found major tag, stop");
            return "major";
        }

        if (minor.test(message)) {
            // core.info("found minor tag");

            releaseBump = "minor";
            continue;
        }

        if (releaseBump !== "minor" && patch.test(message)) {
            // core.info("found patch tag");
            releaseBump = "patch";
            continue;
        }

        if (releaseBump !== "minor" && fix.test(message)) {
            // core.info("found a fix message, check issue for enhancements");

            const id = matcher.exec(message);

            if (id && Number(id[1]) > 0) {
                const issue_number = Number(id[1]);

                core.info(`check issue ${issue_number} for minor labels`);

                const { data } = await octokit.rest.issues.get({
                    owner,
                    repo,
                    issue_number
                });

                if (data) {
                    releaseBump = "patch";

                    for (const label of data.labels) {

                        if (issueTags.indexOf(label.name) >= 0) {
                            core.info("found enhancement issue");
                            releaseBump = "minor";
                            break;
                        }
                    }
                }
            }

            // continue;
        }
        // core.info("no info message");
    }

    return releaseBump;
}

function isReleaseBranch(branchName, branchList) {
    for (const branch of branchList.split(",").map(b => b.trim())) {
        const testBranchName = new RegExp(branch);

        if (testBranchName.test(branchName)) {
            return true;
        }
    }
    return false;
}

async function action() {
    core.info(`run for ${ owner } / ${ repo }`);

    // core.info(`payload ${JSON.stringify(github.context.payload.repository, undefined, 2)}`);

    // prepare octokit
    const token = core.getInput("github-token", {required: true});
    const octokit = new github.getOctokit(token);

    // load inputs
    // const customTag     = core.getInput('custom-tag');
    const dryRun        = core.getInput("dry-run").toLowerCase();
    const level         = core.getInput("bump");
    const forceBranch   = core.getInput("branch");
    const releaseBranch = core.getInput("release-branch");
    const withV         = core.getInput("with-v").toLowerCase() === "false" ? "" : "v";
    const customTag     = core.getInput("tag");
    const issueLabels   = core.getInput("issue-labels");

    let branchInfo, nextVersion;

    if (forceBranch) {
        core.info(`check forced branch ${forceBranch}`);

        branchInfo = await loadBranch(octokit, forceBranch);

        if (!branchInfo) {
            throw new Error("unknown branch provided");
        }

        core.info("branch confirmed, continue");
    }

    if (!branchInfo) {
        const activeBranch = github.context.ref.replace(/refs\/heads\//, "");

        core.info(`load the history of activity-branch ${ activeBranch } from context ref ${ github.context.ref }`);
        branchInfo  = await loadBranch(octokit, activeBranch);

        if (!branchInfo) {
            throw new Error(`failed to load branch ${ activeBranch }`);
        }
    }

    // the sha for tagging
    const sha        = branchInfo.object.sha;
    const branchName = branchInfo.ref.split("/").pop();

    core.info(`active branch name is ${ branchName }`);

    if (customTag){
        if (checkTag(octokit, customTag)) {
            throw new Error(`tag already exists ${customTag}`);
        }

        core.setOutput("new-tag", customTag);
    }
    else {
        core.info(`maching refs: ${ sha }`);

        const latestTag = await getLatestTag(octokit);
        const latestMainTag = await getLatestTag(octokit, false);

        core.info(`the previous tag of the repository ${ JSON.stringify(latestTag, undefined, 2) }`);
        core.info(`the previous main tag of the repository ${ JSON.stringify(latestMainTag, undefined, 2) }`);

        const versionTag = latestTag && latestTag.name ? latestTag.name : "0.0.0";

        core.setOutput("tag", versionTag);

        if (latestTag && latestTag.commit.sha === sha) {
            core.info("no new commits, avoid tagging");

            // in this case the new and the old tag are the same.
            core.setOutput("new-tag", versionTag);
            return;
        }

        core.info(`The repo tags: ${ JSON.stringify(latestTag, undefined, 2) }`);

        const version   = semver.clean(versionTag);

        nextVersion = semver.inc(
            version,
            "prerelease",
            branchName
        );

        core.info(`default to prerelease version ${ nextVersion }`);

        let issLabs = ["enhancement"];

        if (issueLabels) {
            const xlabels = issueLabels.split(",").map(lab => lab.trim());

            if (xlabels.length) {
                issLabs = xlabels;
            }
        }

        // check if commits and issues point to a diffent release level
        // This filters hash tags for major, minor, patch and wip commit messages.
        core.info("commits in branch");

        const msgLevel = await checkMessages(
            octokit,
            branchInfo.object.sha,
            latestMainTag ? latestMainTag.commit.sha : "", // terminate at the previous tag
            issLabs
        );
        // core.info(`commit messages suggest ${msgLevel} upgrade`);

        if (isReleaseBranch(branchName, releaseBranch)) {
            core.info(`${ branchName } is a release branch`);

            if (msgLevel === "none") {
                nextVersion = semver.inc(version, level);
            }
            else {
                core.info(`commit messages force bump level to ${msgLevel}`);
                nextVersion = semver.inc(version, msgLevel);
            }
        }

        core.info( `bump tag ${ nextVersion }` );

        core.setOutput("new-tag", nextVersion);
    }

    if (dryRun === "true") {
        core.info("dry run, don't perform tagging");
        return;
    }

    const newTag = `${ withV }${ nextVersion }`;

    core.info(`really add tag ${ customTag ? customTag : newTag }`);

    const ref = `refs/tags/${ customTag ? customTag : newTag }`;

    await octokit.rest.git.createRef({
        owner,
        repo,
        ref,
        sha
    });
}

action()
    .then(() => core.info("success"))
    .catch(error => core.setFailed(error.message));
