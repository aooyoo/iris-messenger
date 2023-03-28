import { throttle } from 'lodash';
import isEqual from 'lodash/isEqual';
import styled from 'styled-components';

import Component from '../BaseComponent';
import Helpers from '../Helpers';
import Icons from '../Icons';
import localState from '../LocalState';
import Events from '../nostr/Events';
import Key from '../nostr/Key';
import PubSub from '../nostr/PubSub';
import SocialNetwork from '../nostr/SocialNetwork';
import { translate as t } from '../translations/Translation';

import { PrimaryButton as Button } from './buttons/Button';
import EventComponent from './events/EventComponent';
import ErrorBoundary from './ErrorBoundary';

const INITIAL_PAGE_SIZE = 20;

let isInitialLoad = true;
const listener = function () {
  isInitialLoad = false;
  window.removeEventListener('popstate', listener);
};
window.addEventListener('popstate', listener);

const ImageGrid = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  grid-gap: 10px;
  @media (max-width: 625px) {
    grid-gap: 1px;
  }
`;

const DEFAULT_SETTINGS = {
  display: 'posts',
  realtime: false,
  replies: true,
  sortBy: 'created_at',
  sortDirection: 'desc',
  timespan: 'all',
};

class Feed extends Component {
  constructor() {
    super();
    let savedSettings = {};
    localState
      .get('settings')
      .get('feed')
      .once((s) => (savedSettings = s));
    this.state = {
      sortedEvents: [],
      queuedEvents: [],
      displayCount: INITIAL_PAGE_SIZE,
      eventsShownTime: Math.floor(Date.now() / 1000),
      settings: this.getSettings(savedSettings),
    };
    this.openedAt = Math.floor(Date.now() / 1000);
  }

  getSettings(override = {}) {
    // override default & saved settings with url params
    let settings = { ...DEFAULT_SETTINGS };
    if (['global', 'follows'].includes(this.props?.index)) {
      settings = Object.assign(settings, override);
    }
    if (this.props?.index !== 'notifications' && override.display) {
      settings.display = override.display;
    }
    for (const key in settings) {
      const value = Helpers.getUrlParameter(key);
      if (value !== null) {
        // if value is '1' or '0', convert to boolean
        if (value === '1' || value === '0') {
          settings[key] = value === '1';
        } else {
          settings[key] = value;
        }
      }
    }
    return settings;
  }

  saveSettings() {
    localState.get('settings').get('feed').put(this.state.settings);
  }

  updateSortedEvents = (sortedEvents) => {
    if (this.unmounted || !sortedEvents) {
      return;
    }
    const settings = this.state.settings;
    // iterate over sortedEvents and add newer than eventsShownTime to queue
    const queuedEvents = [];
    let hasMyEvent;
    if (settings.sortDirection === 'desc' && !settings.realtime) {
      for (let i = 0; i < sortedEvents.length; i++) {
        const id = sortedEvents[i];
        const event = Events.db.by('id', id);
        if (event && event.created_at > this.state.eventsShownTime) {
          if (event.pubkey === Key.getPubKey() && !Events.isRepost(event)) {
            hasMyEvent = true;
            break;
          }
          queuedEvents.push(id);
        }
      }
    }
    if (!hasMyEvent) {
      sortedEvents = sortedEvents.filter((id) => !queuedEvents.includes(id));
    }
    const eventsShownTime = hasMyEvent ? Math.floor(Date.now() / 1000) : this.state.eventsShownTime;
    this.setState({ sortedEvents, queuedEvents, eventsShownTime });
  };

  handleScroll = () => {
    // increase page size when scrolling down
    if (this.state.displayCount < this.state.sortedEvents.length) {
      if (
        this.props.scrollElement.scrollTop + this.props.scrollElement.clientHeight >=
        this.props.scrollElement.scrollHeight - 1000
      ) {
        this.setState({ displayCount: this.state.displayCount + INITIAL_PAGE_SIZE });
      }
    }
    this.checkScrollPosition();
  };

  checkScrollPosition = () => {
    // if scrolled past this.base element's start, apply fixedTop class to it
    if (!this.props.scrollElement) {
      return;
    }
    const showNewMsgsFixedTop = this.props.scrollElement.scrollTop > this.base.offsetTop - 60;
    if (showNewMsgsFixedTop !== this.state.fixedTop) {
      this.setState({ showNewMsgsFixedTop });
    }
  };

  componentWillUnmount() {
    super.componentWillUnmount();
    if (this.props.scrollElement) {
      this.props.scrollElement.removeEventListener('scroll', this.handleScroll);
    }
    this.unsub && this.unsub();
  }

  addScrollHandler() {
    if (this.props.scrollElement) {
      this.props.scrollElement.addEventListener('scroll', this.handleScroll);
    }
  }

  componentWillMount() {
    if (!isInitialLoad && window.history.state?.state) {
      this.setState(window.history.state.state);
    }
  }

  componentDidMount() {
    this.addScrollHandler();
    this.subscribe();
    if (isEqual(this.state.settings, DEFAULT_SETTINGS)) {
      // no settings saved in history state, load from localstorage
      localState
        .get('settings')
        .get('feed')
        .on(
          this.sub((s) => {
            const settings = this.getSettings(s);
            this.setState({ settings });
          }),
        );
    }
    let first = true;
    localState.get('scrollUp').on(
      this.sub(() => {
        !first && Helpers.animateScrollTop('.main-view');
        first = false;
      }),
    );
  }

  subscribe() {
    this.unsub?.();
    const update = (events) => {
      this.updateSortedEvents(
        events
          .filter((e) => {
            if (SocialNetwork.blockedUsers.has(e.pubkey)) {
              return false;
            }
            const repliedMsg = Events.getEventReplyingTo(e);
            if (repliedMsg) {
              const author = Events.db.by('id', repliedMsg)?.pubkey;
              if (author && SocialNetwork.blockedUsers.has(author)) {
                return false;
              }
            }
            return true;
          })
          .sort(this.sort.bind(this))
          .map((e) => e.id),
      );
    };
    const throttledUpdate = throttle(update, 1000, { leading: true });
    const callback = (events) => {
      if (events.length < 10) {
        update(events);
      } else {
        throttledUpdate(events);
      }
    };
    setTimeout(() => {
      if (this.props.index === 'notifications') {
        const myPub = Key.getPubKey();
        this.unsub = PubSub.subscribe(
          [{ '#p': [myPub] }],
          (events) => {
            // TODO make sure PubSub subscribe filters correctly
            callback(events.filter((e) => e.tags?.some((t) => t[0] === 'p' && t[1] === myPub)));
          },
          'feed',
          true,
        );
      } else {
        this.unsub = this.getEvents(callback);
      }
    }, 0);
  }

  sort(a, b) {
    let aVal;
    let bVal;
    if (!a || !b) return 0;
    if (a && !b) return -1;
    if (!a && b) return 1;
    if (this.state.settings.sortBy === 'created_at') {
      aVal = a.created_at;
      bVal = b.created_at;
    } else if (this.state.settings.sortBy === 'likes') {
      aVal = Events.likesByMessageId.get(a.id)?.size || 0;
      bVal = Events.likesByMessageId.get(b.id)?.size || 0;
    } else if (this.state.settings.sortBy === 'zaps') {
      aVal = Events.zapsByNote.get(a.id)?.size || 0;
      bVal = Events.zapsByNote.get(b.id)?.size || 0;
    }
    if (this.state.settings.sortDirection === 'desc') {
      return bVal - aVal;
    } else {
      return aVal - bVal;
    }
  }

  getEvents(callback) {
    if (this.props.index === 'notifications') {

    }
    if (this.props.nostrUser) {
      if (this.props.index === 'likes') {
        return PubSub.subscribe(
          // TODO map to liked msg id
          [{ authors: [this.props.nostrUser], kinds: [7] }],
          (events) => callback(events),
          'user',
        );
      } else {
        return PubSub.subscribe(
          [{ authors: [this.props.nostrUser], kinds: [1, 6] }],
          (events) =>
            callback(
              events.filter((e) => {
                if (this.props.index === 'posts') {
                  return !Events.getEventReplyingTo(e);
                }
                return true;
              }),
            ),
          'user',
        );
      }
    } else if (this.props.keyword) {
      return PubSub.subscribe(
        [{ keywords: [this.props.keyword], kinds: [1] }],
        (events) => callback(events.filter((e) => e.content?.includes(this.props.keyword))),
        'keyword',
      );
    } else {
      return PubSub.subscribe(
        [{ kinds: [1, 6] }],
        (events) => {
          if (this.props.index === 'follows') {
            events = events.filter((e) => {
              return SocialNetwork.followDistanceByUser.get(e.pubkey) <= 1;
            });
          }
          callback(events);
        },
        'global',
        true,
      );
    }
  }

  updateParams(prevState) {
    if (prevState.settings.display !== this.state.settings.display) {
      const url = new URL(window.location);
      if (this.state.settings.display === 'grid') {
        url.searchParams.set('display', 'grid');
      } else {
        url.searchParams.delete('display');
      }
      this.replaceState();
    }
    if (prevState.settings.replies !== this.state.settings.replies) {
      const url = new URL(window.location);
      if (this.state.settings.replies) {
        url.searchParams.set('replies', '1');
      } else {
        url.searchParams.delete('replies');
      }
      this.replaceState();
    }
    if (prevState.settings.realtime !== this.state.settings.realtime) {
      const url = new URL(window.location);
      if (this.state.settings.realtime) {
        url.searchParams.set('realtime', '1');
      } else {
        url.searchParams.delete('realtime');
      }
      this.replaceState();
    }
  }

  replaceState = throttle(
    () => {
      window.history.replaceState({ ...window.history.state, state: this.state }, '');
    },
    1000,
    { leading: true, trailing: true },
  );

  componentDidUpdate(prevProps, prevState) {
    if (!prevProps.scrollElement && this.props.scrollElement) {
      this.addScrollHandler();
    }
    if (!isEqual(prevState.settings, this.state.settings)) {
      this.setState({ displayCount: INITIAL_PAGE_SIZE });
      this.updateParams(prevState);
      this.subscribe();
    }
    this.handleScroll();
    this.replaceState();
    if (!this.state.queuedEvents.length && prevState.queuedEvents.length) {
      Helpers.animateScrollTop('.main-view');
    }
    if (this.props.filter !== prevProps.filter || this.props.keyword !== prevProps.keyword) {
      this.setState({ sortedEvents: [] });
      this.componentDidMount();
    }
  }

  showqueuedEvents() {
    const sortedEvents = this.state.sortedEvents;
    console.log('sortedEvents.length', sortedEvents.length);
    sortedEvents.unshift(...this.state.queuedEvents);
    console.log('queuedEvents.length', this.state.queuedEvents.length);
    this.setState({
      sortedEvents,
      queuedEvents: [],
      eventsShownTime: Math.floor(Date.now() / 1000),
      displayCount: INITIAL_PAGE_SIZE,
    });
  }

  renderFeedTypeSelector() {
    const isProfile = ['posts', 'postsAndReplies', 'likes'].includes(this.props.index);
    return (
      <div className="tabs">
        <a
          style={isProfile ? { 'border-radius': '8px 0 0 0' } : {}}
          onClick={() => {
            this.setState({ settings: { ...this.state.settings, display: 'posts' } }); // faster to do this also
            localState.get('settings').get('feed').get('display').put('posts');
          }}
          className={this.state.settings.display === 'grid' ? '' : 'active'}
        >
          {Icons.post}
        </a>
        <a
          style={isProfile ? { 'border-radius': '0 8px 0 0' } : {}}
          className={this.state.settings.display === 'grid' ? 'active' : ''}
          onClick={() => {
            this.setState({ settings: { ...this.state.settings, display: 'grid' } }); // faster to do this also
            localState.get('settings').get('feed').get('display').put('grid');
          }}
        >
          {Icons.image}
        </a>
      </div>
    );
  }

  renderSettings() {
    const inputs = [
      {
        type: 'checkbox',
        id: 'display_realtime',
        checked: this.state.settings.realtime,
        label: t('realtime'),
        onChange: () =>
          this.setState({
            settings: { ...this.state.settings, realtime: !this.state.settings.realtime },
          }),
      },
      {
        type: 'checkbox',
        id: 'show_replies',
        checked: this.state.settings.replies,
        name: 'replies',
        label: t('show_replies'),
        onChange: () =>
          this.setState({
            settings: { ...this.state.settings, replies: !this.state.settings.replies },
          }),
      },
    ];

    const radioGroups = [
      {
        label: t('display'),
        name: 'display',
        inputs: [
          { value: 'posts', id: 'display_posts', label: t('posts') },
          { value: 'grid', id: 'display_grid', label: t('grid') },
        ],
        checked: this.state.settings.display,
        onChange: (e) =>
          this.setState({ settings: { ...this.state.settings, display: e.target.value } }),
      },
      {
        label: t('sort_by'),
        name: 'sortBy',
        inputs: [
          { value: 'created_at', id: 'sortByTime', label: t('time') },
          { value: 'likes', id: 'sortByLikes', label: t('likes') },
          { value: 'zaps', id: 'sortByZaps', label: t('zaps') },
        ],
        checked: this.state.settings.sortBy,
        onChange: (e) =>
          this.setState({ settings: { ...this.state.settings, sortBy: e.target.value } }),
      },
      {
        label: t('sort_direction'),
        name: 'ordering',
        inputs: [
          { value: 'desc', id: 'ordering_desc', label: '▼' },
          { value: 'asc', id: 'ordering_asc', label: '▲' },
        ],
        checked: this.state.settings.sortDirection,
        onChange: (e) =>
          this.setState({ settings: { ...this.state.settings, sortDirection: e.target.value } }),
      },
      {
        label: t('timespan'),
        name: 'timespan',
        inputs: [
          { value: 'all', id: 'timespanAll', label: t('All time') },
          { value: 'day', id: 'timespanDay', label: t('day') },
          { value: 'week', id: 'timespanWeek', label: t('week') },
          { value: 'month', id: 'timespanMonth', label: t('month') },
          { value: 'year', id: 'timespanYear', label: t('year') },
        ],
        checked: this.state.settings.timespan,
        onChange: (e) =>
          this.setState({ settings: { ...this.state.settings, timespan: e.target.value } }),
      },
    ];
    return (
      <div className="msg">
        <div className="msg-content">
          <div style="display:flex;flex-direction:column">
            <div>
              {inputs.map((input, i) => (
                <span key={i}>
                  <input {...input} />
                  <label htmlFor={input.id}>{input.label}</label>
                </span>
              ))}
            </div>
            {radioGroups.map((group, i) => (
              <div key={i} style={{ flexDirection: 'column' }}>
                <p>{group.label}:</p>
                <p>
                  {group.inputs.map((input, j) => (
                    <span key={j}>
                      <input
                        type="radio"
                        name={group.name}
                        id={input.id}
                        value={input.value}
                        checked={group.checked === input.value}
                        onChange={group.onChange}
                      />
                      <label htmlFor={input.id}>{input.label}</label>
                    </span>
                  ))}
                </p>
              </div>
            ))}
            <p>
              <Button onClick={() => this.saveSettings()}>{t('save_as_defaults')}</Button>
            </p>
          </div>
        </div>
      </div>
    );
  }

  renderShowNewEvents() {
    return (
      <div
        className={`msg ${this.state.showNewMsgsFixedTop ? 'fixedTop' : ''}`}
        onClick={() => this.showqueuedEvents()}
      >
        <div className="msg-content notification-msg colored">
          {t('show_n_new_messages').replace('{n}', this.state.queuedEvents.length)}
        </div>
      </div>
    );
  }

  renderShowMore() {
    return (
      <p>
        <Button
          onClick={() =>
            this.setState({
              displayCount: this.state.displayCount + INITIAL_PAGE_SIZE,
            })
          }
        >
          {t('show_more')}
        </Button>
      </p>
    );
  }

  render() {
    if (!this.props.scrollElement || this.unmounted) {
      return;
    }
    const displayCount = this.state.displayCount;
    const showRepliedMsg = this.props.index !== 'likes' && !this.props.keyword;
    const feedName =
      !this.state.queuedEvents.length &&
      {
        global: 'global_feed',
        follows: 'following',
        notifications: 'notifications',
      }[this.props.index];

    const renderAs = this.state.settings.display === 'grid' ? 'NoteImage' : null;
    const events = this.state.sortedEvents.slice(0, displayCount).map((id) => (
      <ErrorBoundary>
        <EventComponent
          notification={this.props.index === 'notifications'}
          key={id}
          id={id}
          showRepliedMsg={showRepliedMsg}
          renderAs={renderAs}
          feedOpenedAt={this.openedAt}
        />
      </ErrorBoundary>
    ));
    const isGeneralFeed = ['global', 'follows'].includes(this.props.index);
    return (
      <div className="msg-feed">
        <div>
          {this.state.queuedEvents.length ? this.renderShowNewEvents() : null}
          {feedName ? (
            <div className="msg">
              <div className="msg-content notification-msg">
                <div style="display:flex;flex-direction: row;width:100%;align-items:center;text-align:center;">
                  {isGeneralFeed && (
                    <a href="/" style="padding-right: 10px;color:var(--text-color);">
                      {Icons.backArrow}
                    </a>
                  )}
                  <div style="flex:1;">{t(feedName)}</div>
                  {isGeneralFeed && (
                    <a
                      style="padding: 0 10px;color:var(--text-color);"
                      onClick={() => this.setState({ settingsOpen: !this.state.settingsOpen })}
                    >
                      {Icons.settings}
                    </a>
                  )}
                </div>
              </div>
            </div>
          ) : null}
          {this.props.index !== 'notifications' && this.state.settingsOpen && this.renderSettings()}
          {this.props.index !== 'notifications' && this.renderFeedTypeSelector()}
          {events.length === 0 && (
            <div className="msg">
              <div className="msg-content notification-msg">
                {this.props.emptyMessage || t('no_events_yet')}
              </div>
            </div>
          )}
          {renderAs === 'NoteImage' ? <ImageGrid>{events}</ImageGrid> : events}
        </div>
        {displayCount < this.state.sortedEvents.length ? this.renderShowMore() : ''}
      </div>
    );
  }
}

export default Feed;
